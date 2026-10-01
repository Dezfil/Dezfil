import { bindingKey, tableRef } from "./input-ref";
import { namedSql } from "@/lib/query/named-sql";
import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { h3Ready } from "@/lib/duckdb";
import type { DataTable } from "@/lib/metadata/tables";
import type { OperationDef } from "./catalog";
import type { CompiledRun } from "./compile";
import {
  assumedCrsOf,
  columnsOf,
  crsFor,
  fields,
  inputTable,
  metres,
  required,
  str,
} from "./compile-support";
import { isScalarNumeric } from "./column-types";
import { geometryClassOf } from "./geometry-class";
import {
  CLUSTER_COLUMNS,
  CLUSTER_HELPER_COLUMNS,
  H3_CELL_COLUMN,
  HOTSPOT_COLUMNS,
  MAX_CLUSTER_ROWS,
  MAX_NEIGHBOURS,
  MAX_RESOLUTION,
  MIN_RESOLUTION,
  clusterByDistanceSql,
  h3CellSql,
  hotspotSql,
} from "./statistics-verbs";

/**
 * Admission for the statistics verbs.
 *
 * **Separate from `compile.ts` on purpose.** These three carry the most
 * admission surface in the phase — two bounded parameters, a range H3 answers
 * null outside rather than failing, an extension that may not be loaded, a row
 * bound, and a statistic with an undefined case that has to be refused before a
 * job exists. Growing that into a module already at 851 lines is how the next
 * monolith gets built; the shared helpers both compilers need moved to
 * `compile-support.ts` instead.
 */

/** An integer parameter inside a range the engine will not enforce itself. */
function boundedInteger(
  params: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
  fallback: number | null,
): number {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    if (fallback === null) required(label, key);
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ApiError(
      "invalid_request",
      `"${key}" must be a whole number between ${min} and ${max}.`,
      400,
    );
  }
  if (value < min || value > max) {
    throw new ApiError(
      "invalid_request",
      `"${key}" must be between ${min} and ${max}. ${
        key === "resolution"
          ? "That is H3's own range of cell sizes."
          : `Past ${max} steps a neighbourhood has stopped being one.`
      }`,
      400,
    );
  }
  return value;
}

/**
 * The two verbs that call H3 refuse where it never loaded.
 *
 * **The check has to wait for the instance.** Availability is answered by a
 * flag the hardened instance sets while it loads its extensions, so asking
 * before that instance exists answers "absent" for a start-up reason rather
 * than a capability one — and would refuse a perfectly good run on a cold
 * process. Clustering does not come through here at all: it calls no H3
 * function, and posture is that an absent optional extension degrades the
 * capabilities that need it, not the ones that do not.
 */
async function requireH3(scope: DatasetScope, label: string): Promise<void> {
  if (await h3Ready(scope)) return;
  throw new ApiError(
    "invalid_request",
    `${label} needs the H3 extension, which is not loaded on this instance. ` +
      `It is an optional extension: an instance that could not install it ` +
      `still runs everything that does not index by cell.`,
    400,
  );
}

/** A geometry column, or the refusal that says which verb wanted one. */
function geometryOf(table: DataTable, label: string): string {
  if (!table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry column, so ${label} has nothing to ` +
        `place on the grid.`,
      400,
    );
  }
  return table.geometryColumn;
}

/**
 * A column the verb writes may not collide with one the input already has.
 *
 * precedent, applied to generated columns rather than carried ones: two
 * columns of one name come back as `name` and `name_1`, and which is which is
 * the engine's business — so the answer arrives under a name nobody chose.
 */
async function refuseGeneratedCollisions(
  scope: DatasetScope,
  table: DataTable,
  generated: string[],
  label: string,
): Promise<void> {
  const existing = new Set(
    (await columnsOf(scope, table)).map((column) => column.name.toLowerCase()),
  );
  const collides = generated.filter((name) => existing.has(name.toLowerCase()));
  if (collides.length > 0) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" already has a column called "${collides[0]}", and ` +
        `${label} writes one of that name. Rename or drop it first.`,
      400,
    );
  }
}

/**
 * A Gi\* over values with no spread has no answer for any cell, and this is
 * where that is found out.
 *
 * It costs one aggregate over the input at admission — the same order of work
 * `extentOf` already spends for every measured verb. The alternative is a run
 * that succeeds and writes a whole dataset of null scores, which looks like an
 * answer and is not one.
 */
async function refuseFlatUniverse(
  scope: DatasetScope,
  table: DataTable,
  geometry: string,
  resolution: number,
  value: "count" | "sum",
  field: string | null,
  label: string,
): Promise<void> {
  const geom = ident(geometry);
  const aggregate = value === "count" ? "count(*)" : `sum(${ident(field!)})`;
  const contributes = value === "count" ? "" : ` AND ${ident(field!)} IS NOT NULL`;
  // **The probe must see the universe the generator will see.** A geometry
  // that is not empty but cannot be placed — `POINT(NaN 0)` — groups under a
  // null cell here and is dropped by the generator's own `HAVING`. Counting it
  // showed spread that the real run does not have, and admitted a run whose
  // every score is null. Found at the cross-model review.
  //
  // **The comparison happens in the engine, not in JavaScript.** Two distinct
  // 64-bit sums above 2^53 collapse to the same double, so a `Number()`
  // round trip can report a flat universe that is not flat — and `count(DISTINCT)`
  // answers the question exactly, at the same cost.
  const row = await boundedEvaluation(async (conn) => {
    const reader = await conn.runAndReadAll(await namedSql(conn,
      `SELECT count(*) AS cells, count(DISTINCT v) AS distinct_values FROM (
         SELECT h3_latlng_to_cell_string(ST_Y(ST_Centroid(${geom})), ST_X(ST_Centroid(${geom})), ${resolution}) AS cell,
                ${aggregate} AS v
         FROM ${tableRef(table)}
         WHERE ${geom} IS NOT NULL AND NOT ST_IsEmpty(${geom})${contributes}
         GROUP BY 1
         HAVING cell IS NOT NULL AND ${aggregate} IS NOT NULL)`,
    ));
    return reader.getRowObjects()[0] as Record<string, unknown> | undefined;
  }, { scope });
  const cells = Number(row?.cells ?? 0);
  if (cells === 0) {
    throw new ApiError(
      "invalid_request",
      `Nothing in "${table.name}" lands on the grid at this resolution, so ` +
        `${label} has no cells to score.`,
      400,
    );
  }
  // **One cell is as flat as a hundred identical ones**, and it is the
  // commoner case: a coarse resolution over a small dataset puts everything in
  // one cell, whose score would be null because there is nothing to stand out
  // from. A run that publishes a single null score is not an answer.
  if (cells === 1 || Number(row?.distinct_values ?? 0) <= 1) {
    throw new ApiError(
      "invalid_request",
      cells === 1
        ? `Everything in "${table.name}" falls in one cell at this ` +
            `resolution, so there is nothing for it to stand out from and a ` +
            `z-score does not exist. Try a finer resolution.`
        : `Every cell of "${table.name}" holds the same value at this ` +
            `resolution, so no cell stands out from the rest and a z-score ` +
            `does not exist. Try a finer resolution, or a value that varies.`,
      400,
    );
  }
}

/** Moved to `column-types` when gave the catalog a way to *declare* the
 * kind of column a parameter needs: the form and admission have to answer that
 * question the same way, and the form cannot import this module. Re-exported
 * because this is where the rule was established and where its test looks. */
export { isScalarNumeric };

/** Whether this compiler owns the operation. */
export function isStatisticsVerb(id: string): boolean {
  return id === "h3_cell" || id === "hotspot" || id === "cluster_by_distance";
}

export async function compileStatisticsVerb(
  scope: DatasetScope,
  operation: OperationDef,
  params: Record<string, unknown>,
  requireName: boolean,
): Promise<CompiledRun> {
  const label = operation.label;
  const name = str(params, "name");
  if (requireName && !name) required(label, "name");

  const named = str(params, "input");
  if (!named) required(label, "input");
  const table = inputTable(scope, named, "input");
  const accepts = operation.inputs[0].accepts;
  const held = geometryClassOf(table);
  if (!table.geometryColumn || (held !== null && !accepts.includes(held))) {
    throw new ApiError(
      "invalid_request",
      !table.geometryColumn
        ? `"${table.name}" has no geometry, so it cannot be the input of ${label}. This input takes ${accepts.join(", ")}.`
        : `"${table.name}" holds ${held} geometry, and the input of ${label} takes ${accepts.join(", ")}.`,
      400,
    );
  }
  const bindings = { [bindingKey(table)]: table.file };

  switch (operation.id) {
    case "h3_cell": {
      await requireH3(scope, label);
      const resolution = boundedInteger(
        params,
        "resolution",
        label,
        MIN_RESOLUTION,
        MAX_RESOLUTION,
        null,
      );
      const boundary = params.boundary === true;
      await refuseGeneratedCollisions(scope, table, [H3_CELL_COLUMN], label);
      geometryOf(table, label);
      return { sql: h3CellSql(table, resolution, boundary), name, bindings };
    }
    case "hotspot": {
      await requireH3(scope, label);
      const geometry = geometryOf(table, label);
      const resolution = boundedInteger(
        params,
        "resolution",
        label,
        MIN_RESOLUTION,
        MAX_RESOLUTION,
        null,
      );
      const neighbours = boundedInteger(
        params,
        "neighbours",
        label,
        1,
        MAX_NEIGHBOURS,
        1,
      );
      const mode = str(params, "value") || "count";
      if (mode !== "count" && mode !== "sum") {
        throw new ApiError(
          "invalid_request",
          `"value" must be count or sum.`,
          400,
        );
      }
      let field: string | null = null;
      if (mode === "sum") {
        const named = await fields(scope, table, params.field, "value column");
        if (named.length !== 1) required(label, "field");
        field = named[0];
        const column = (await columnsOf(scope, table)).find(
          (c) => c.name.toLowerCase() === field!.toLowerCase(),
        );
        if (!column || !isScalarNumeric(column.type)) {
          throw new ApiError(
            "invalid_request",
            `"${field}" is not a numeric column, so it cannot be summed into ` +
              `cell values. Score by count instead, or choose a number column.`,
            400,
          );
        }
      }
      await refuseFlatUniverse(scope, table, geometry, resolution, mode, field, label);
      return {
        sql: hotspotSql(table, resolution, neighbours, mode, field),
        name,
        bindings,
      };
    }
    case "cluster_by_distance": {
      const distance = metres(params, "distance", label, true)!;
      // **The bound is read from the registry, not from the engine** (G5): the
      // recorded row count is an upper bound on the points that will be
      // clustered, and admission is not the place to spend a scan proving a
      // smaller number when the answer either way is a refusal.
      if ((table.rowCount ?? 0) > MAX_CLUSTER_ROWS) {
        throw new ApiError(
          "invalid_request",
          `"${table.name}" has ${table.rowCount!.toLocaleString("en-US")} rows, ` +
            `and clustering follows chains through at most ` +
            `${MAX_CLUSTER_ROWS.toLocaleString("en-US")}. Above that the run ` +
            `would not come back. Filter the points first, then cluster.`,
          400,
        );
      }
      await refuseGeneratedCollisions(scope,
        table,
        [...CLUSTER_COLUMNS, ...CLUSTER_HELPER_COLUMNS],
        label,
      );
      const crs = await crsFor(scope, [table], "clustering");
      return {
        sql: clusterByDistanceSql(table, distance, crs),
        name,
        measurement: {
          crs: { distance: crs.crs },
          fallback: !crs.local,
          assumedCrs: assumedCrsOf([table]),
        },
        bindings,
      };
    }
    default:
      throw new ApiError(
        "invalid_request",
        `The ${label} cannot be run yet.`,
        400,
      );
  }
}

export { HOTSPOT_COLUMNS };

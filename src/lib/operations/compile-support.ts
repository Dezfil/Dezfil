import type { DatasetScope } from "@/lib/query/access";
import { tableRef, type InputTable } from "./input-ref";
export { tableRef, bindingKey, type InputTable } from "./input-ref";
import type { DuckDBConnection } from "@duckdb/node-api";
import { classifyReference, registryTable, resolveParameter } from "@/lib/query/bindings";
import { namespaceFor } from "@/lib/query/namespace";
import { namedSql } from "@/lib/query/named-sql";
import { qualifiedNameParts } from "@/lib/query/qualified-name";
import { ApiError } from "@/lib/api/errors";
import { boundedEvaluation } from "@/lib/query/bounded";
import { GROUND_METRES_MAX } from "./catalog";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import { resolveMeasurementCrs, type Extent, type MeasurementCrs } from "./measurement";
import { requireColumn } from "./table-verbs";
import type { CarriedField, ColumnType } from "./spatial-join";

/**
 * What every verb's admission needs, in one place.
 *
 * **Extracted from `compile.ts`**, which adds the three verbs with the most
 * admission surface in the phase. That module was at 851 lines and is the next
 * monolith after the four the decomposition habit names; three more verbs
 * compiled inside it would have pushed it past a thousand. Nothing here
 * changed on the way out — it is the same code, imported by the compiler it
 * came from and by the statistics compiler beside it.
 *
 * What belongs here is the part that is *about admission itself*: reading a
 * parameter, resolving a named table, checking a column exists, refusing a
 * geometry class the verb does not take, and resolving the projection a
 * measured verb measures in. What does not belong here is any verb's own
 * meaning.
 */

export function required_(operationLabel: string, parameter: string): never {
  return required(operationLabel, parameter);
}

export function required(operationLabel: string, parameter: string): never {
  throw new ApiError(
    "invalid_request",
    `The ${operationLabel} needs a "${parameter}" parameter.`,
    400,
  );
}

export function str(params: Record<string, unknown>, key: string): string {
  return typeof params[key] === "string" ? (params[key] as string) : "";
}

/** Read a table the caller named, or say which one it could not find. */
export function inputTable(scope: DatasetScope, name: string, role: string): InputTable {
  const { resolution } = resolveParameter(namespaceFor(scope), name);
  if (resolution.status !== "bound") {
    // Most roles read as adjectives ("left", "clip", "buffer's") — but the
    // generic single-input key is literally "input", and doubling it shipped
    // "The input input" (fixed at the 2026-08-17 sitting).
    const said = role === "input" ? "input" : `${role} input`;
    throw new ApiError(
      "not_found",
      `The ${said} "${name}" is not a table in this workspace.`,
      404,
    );
  }
  const { dataset } = resolution;
  const qualified = classifyReference(qualifiedNameParts(name) ?? [name]).form === "qualified";
  const ref = qualified ? `${ident(dataset.ownerSqlName!)}.${ident(dataset.name)}` : ident(dataset.name);
  const key = qualified ? `${dataset.ownerSqlName}.${dataset.name}`.toLowerCase() : dataset.name.toLowerCase();
  return { ...registryTable(dataset), ref, key };
}

/** A probe of one input, compiled in the evaluation's namespace. */
async function probe(conn: DuckDBConnection, sql: string): Promise<string> {
  return namedSql(conn, sql);
}

/** The columns and types the engine reports for a registered table. */
export async function columnsOf(scope: DatasetScope, table: DataTable): Promise<ColumnType[]> {
  return boundedEvaluation(async (conn) => {
    const described = await conn.runAndReadAll(
      `DESCRIBE ${await probe(conn, `SELECT * FROM ${tableRef(table)}`)}`,
    );
    return (
      described.getRowObjects() as unknown as {
        column_name: string;
        column_type: string;
      }[]
    ).map((c) => ({ name: String(c.column_name), type: String(c.column_type) }));
  }, { scope });
}

/**
 * Read the carried-field list without flattening it.
 *
 * A malformed entry is refused here rather than reaching the validator as
 * `undefined`, because the validator's messages are about *choices a user
 * made* and would misdescribe a structurally wrong request.
 */
export function carriedFields(value: unknown): CarriedField[] {
  if (!Array.isArray(value)) {
    throw new ApiError(
      "invalid_request",
      `"carry" must be a list of values to bring across from the right input.`,
      400,
    );
  }
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ApiError(
        "invalid_request",
        `Carried value ${i + 1} must be an object with an "aggregate", and a ` +
          `"field" for every aggregate except count.`,
        400,
      );
    }
    const e = entry as Record<string, unknown>;
    return {
      aggregate: e.aggregate as CarriedField["aggregate"],
      ...(typeof e.field === "string" ? { field: e.field } : {}),
      ...(typeof e.as === "string" ? { as: e.as } : {}),
    };
  });
}

export async function extentOf(scope: DatasetScope, table: DataTable, verb: string): Promise<Extent> {
  if (!table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry column, so ${verb} has nothing to ` +
        `measure.`,
      400,
    );
  }
  const geom = ident(table.geometryColumn);
  const bounds = await boundedEvaluation(async (conn) => {
    const reader = await conn.runAndReadAll(await probe(conn,
      `SELECT ST_XMin(e) AS min_lon, ST_YMin(e) AS min_lat,
              ST_XMax(e) AS max_lon, ST_YMax(e) AS max_lat
       FROM (SELECT ST_Extent_Agg(${geom}) AS e FROM ${tableRef(table)}
             WHERE ${geom} IS NOT NULL)`,
    ));
    return reader.getRowObjects()[0] as Record<string, unknown> | undefined;
  }, { scope });
  const raw = [
    bounds?.min_lon,
    bounds?.min_lat,
    bounds?.max_lon,
    bounds?.max_lat,
  ];
  if (raw.some((value) => value === null || value === undefined)) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no readable extent, so there is nothing to ` +
        `measure; it may hold no rows with geometry.`,
      400,
    );
  }
  const [minLon, minLat, maxLon, maxLat] = raw.map(Number);
  if ([minLon, minLat, maxLon, maxLat].some((n) => !Number.isFinite(n))) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no readable extent, so there is nothing to ` +
        `measure; it may hold no rows with geometry.`,
      400,
    );
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** Which inputs carry an assumed rather than a declared CRS. */
export const assumedCrsOf = (tables: DataTable[]): string[] =>
  tables.filter((t) => t.crsAssumed).map((t) => t.name);

/** The ceiling's refusal, shared so the buffer's own check says the same
 * sentence. */
export function refusePastCeiling(key: string, value: number): void {
  if (value <= GROUND_METRES_MAX) return;
  throw new ApiError(
    "invalid_request",
    `"${key}" must be at most ${GROUND_METRES_MAX.toLocaleString("en-US")} ` +
      `metres; no two points on the ground are farther apart.`,
    400,
  );
}

export function metres(
  params: Record<string, unknown>,
  key: string,
  label: string,
  required: boolean,
): number | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    if (required) required_(label, key);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(
      "invalid_request",
      `"${key}" must be a positive number of metres on the ground.`,
      400,
    );
  }
  refusePastCeiling(key, value);
  return value;
}

/** The columns a caller named, checked against the table's own. */
export async function fields(
  scope: DatasetScope,
  table: DataTable,
  value: unknown,
  role: string,
  { allowGeometry = true }: { allowGeometry?: boolean } = {},
): Promise<string[]> {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const columns = (await columnsOf(scope, table)).map((c) => c.name);
  return list.map((entry) => {
    if (typeof entry !== "string") {
      throw new ApiError(
        "invalid_request",
        `Each ${role} must be the name of a column.`,
        400,
      );
    }
    const column = requireColumn(table, columns, entry, role);
    if (
      !allowGeometry &&
      table.geometryColumn &&
      column.toLowerCase() === table.geometryColumn.toLowerCase()
    ) {
      // Grouping by geometry would put a geometry column in the output of a
      // verb whose catalog entry declares it has none — and the drawer, which
      // reads that declaration, would have disabled *On the map* for a result
      // that then has a shape.
      throw new ApiError(
        "invalid_request",
        `Grouping by "${column}" would group by geometry, and this operation ` +
          `answers a table without any. Group by an attribute instead.`,
        400,
      );
    }
    return column;
  });
}

/**
 * The extent a measured verb resolves its projection from.
 *
 * **Every input it will measure across, not the first one.** A projection
 * centred on the left table alone measures a right table far from it with a
 * stretched scale, so the operation would answer a plausible wrong distance
 * where it should have refused: the exact distortion the width bound exists
 * to prevent. Every input counts toward the extent the projection centres on
 * and the bound is checked against.
 */
export async function crsFor(
  scope: DatasetScope,
  tables: DataTable[],
  verb: string,
): Promise<MeasurementCrs> {
  const extents = await Promise.all(tables.map((t) => extentOf(scope, t, verb)));
  const combined = extents.reduce((a, b) => ({
    minLon: Math.min(a.minLon, b.minLon),
    minLat: Math.min(a.minLat, b.minLat),
    maxLon: Math.max(a.maxLon, b.maxLon),
    maxLat: Math.max(a.maxLat, b.maxLat),
  }));
  return resolveMeasurementCrs(combined, "distance");
}

/**
 * Turn an operation and its parameters into the SQL that will run.
 *
 * Every verb the catalog lists is handled here, and an unhandled one is a
 * coded refusal rather than a crash — the catalog and this switch are the two
 * halves of one promise, and the one that fails loudly is the safe one.
 */

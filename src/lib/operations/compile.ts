import { ApiError } from "@/lib/api/errors";
import type { DataTable } from "@/lib/metadata/tables";
import type { DryRun } from "./materialize";
import { findOperation } from "./catalog";
import { compileGeocode } from "./compile-geocode";
import { compileIsochrone } from "./compile-isochrone";
import { compileStatisticsVerb } from "./compile-statistics";
import { resolveMeasurementCrs } from "./measurement";
import {
  assumedCrsOf,
  carriedFields,
  columnsOf,
  crsFor,
  extentOf,
  fields,
  inputTable,
  metres,
  refusePastCeiling,
  required,
  str,
} from "./compile-support";
import {
  bufferSql,
  measureColumnsSql,
  parseMeasures,
  MEASURE_KIND,
} from "./metric-verbs";
import { centroidSql, convexHullSql, simplifySql } from "./shape-verbs";
import { clipSql, differenceSql, unionSql } from "./overlay-verbs";
import {
  COMPARISONS,
  SUMMARY_AGGREGATES,
  dissolveSql,
  filterRowsSql,
  groupSummarizeSql,
  joinByKeySql,
  requireColumn,
  type Comparison,
  type SummaryAggregate,
} from "./table-verbs";
import {
  LOCATION_RELATIONS,
  filterByLocationSql,
  nearestJoinSql,
  type LocationRelation,
} from "./proximity-verbs";
import type { OperationDef } from "./catalog";
import { geometryClassOf } from "./geometry-class";
import {
  spatialJoinSql,
  validateSpatialJoin,
  type ColumnType,
  type Predicate,
  type SpatialJoinParams,
} from "./spatial-join";

/**
 * Compiling a verb to the SQL that runs.
 *
 * Until this module the run path took a SQL string and an output name and
 * called that "an operation's parameters". That works for exactly one verb.
 * A spatial join's parameters are two named inputs, a predicate and a **list of
 * carried fields** — none of which survives a reduction to a string — so the
 * shape the catalog now declares needs somewhere that reads it.
 *
 * **Compilation happens at admission, before a job exists.** Everything it can
 * refuse — an unknown input, a missing geometry, an aggregate a column cannot
 * take, a carried name colliding with a left field — is knowable from the
 * registry and two schema round trips, and draws its line there: what is
 * cheaply and certainly wrong is refused immediately and mints no job.
 *
 * **What the caller sent is not what this returns.** The generated SQL is what
 * runs; the caller's own parameters are recorded verbatim on the job, so a
 * verb's non-scalar parameters survive the round trip rather than being read
 * back as the reduction that happened to be executable.
 */

/**
 * What a run has to do before it has a statement at all.
 *
 * The lane hands over its own signal and what is left of its own budget, so a
 * preparation is cancelled and timed exactly as the publication that follows
 * it is — contract is that execution is timed from when a run starts running,
 * and a provider phase outside that would be time nothing measured.
 */
export interface PreparationContext {
  signal?: AbortSignal;
  /** Wall-clock instant by which the whole run must be over, publication
   * included. Not a fresh budget: a slow preparation leaves less, never more. */
  deadlineAt: number;
  /** The lane's coded timeout, so work that runs long fails as a run that ran
   * long rather than as a query that did. */
  timeoutError: () => ApiError;
}

export interface PreparedPublication {
  /** The statement to publish, now that what it reads exists. */
  sql: string;
  /**
   * What the output's record carries **in place of** that statement (J9).
   *
   * A provider run's statement names a private staging path, so publishing it
   * would put an internal path in the registry. The doctrine already says what
   * belongs there instead: the request the run made.
   */
  disclosure: Record<string, unknown>;
  /** Called whatever the run's outcome — success, failure, cancellation or
   * timeout. The staging artifact is run-owned. */
  cleanup: () => Promise<void>;
}

export interface CompiledRun {
  /** The read-only SELECT that will be materialized. Empty for a run whose
   * statement does not exist until its preparation has run. */
  sql: string;
  /** The name the output is registered under. */
  name: string;
  /**
   * Where this run measured, when it measured anything.
   *
   * Recorded in the output's provenance: a buffer whose provenance does not
   * name its measurement CRS is not reproducible, because the same operation
   * with the same parameters can produce a different geometry under a later
   * strategy and nothing in the record would explain the difference.
   */
  measurement?: MeasurementRecord;
  /**
   * The input generations this SQL was built for, when the build depended on
   * them. Checked again before the run does any work.
   */
  bindings?: Record<string, string>;
  /**
   * Work the lane must do before this run has a statement.
   *
   * The one generic idea this phase's provider verb needed: an operation may
   * have work to do *before* its SQL runs. Nothing about materialization,
   * lineage, staleness or cascade is special-cased for a provider — what comes
   * back is a statement, and it is published like any other.
   */
  prepare?: (context: PreparationContext) => Promise<PreparedPublication>;
  /**
   * What a dry run answers when the verb can say without running anything.
   *
   * Doctrine E7's rule, and the only way a *provider* verb can answer at all: a
   * dry run must touch no provider, so its row count comes from the promise
   * that one row goes out for every row in, and its class from the catalog's
   * declaration. The one case where the registered dataset differs is a run
   * where nothing matched — a point column with no rows to classify — which is
   * the declaration being kept rather than broken.
   */
  preview?: DryRun;
  /**
   * Inputs whose WGS84 was assumed, for a verb that makes no measurement.
   * The assumed-CRS warning is not a measurement warning — it is about
   * whether the coordinates are trusted, and the isochrone hands them to
   * a router that will start somewhere else entirely if the guess was
   * wrong. Verbs with a measurement record keep carrying it there; both
   * warning roads read either.
   */
  assumedCrs?: string[];
}

export interface MeasurementRecord {
  /** The CRS each kind of measurement happened in. */
  crs: Record<string, string>;
  /** True when a global equal-area projection stood in for a local one. */
  fallback: boolean;
  /** Inputs whose WGS84 was assumed rather than declared. */
  assumedCrs: string[];
}

export interface CompileOptions {
  /** A dry run writes nothing, so it needs no output name. Defaults to true. */
  requireName?: boolean;
}

async function compileSpatialJoin(
  params: Record<string, unknown>,
  label: string,
  requireName: boolean,
): Promise<CompiledRun> {
  const leftName = str(params, "left");
  const rightName = str(params, "right");
  const name = str(params, "name");
  if (!leftName) required(label, "left");
  if (!rightName) required(label, "right");
  if (requireName && !name) required(label, "name");

  const left = inputTable(leftName, "left");
  const right = inputTable(rightName, "right");

  const join: SpatialJoinParams = {
    left: left.name,
    right: right.name,
    // Absent means the catalog's default rather than a silent failure: the
    // catalog declares one and a caller reading it may reasonably omit it.
    predicate: (str(params, "predicate") || "intersects") as Predicate,
    carry: carriedFields(params.carry),
  };

  const [leftColumns, rightColumns] = await Promise.all([
    columnsOf(left),
    columnsOf(right),
  ]);
  validateSpatialJoin(
    join,
    { table: left, columns: leftColumns },
    { table: right, columns: rightColumns },
  );

  return { sql: spatialJoinSql(join, left, right), name };
}

/**
 * The extent the engine reports for a registered table, as the strategy needs
 * it — **the whole table's, not its first row's**.
 *
 * `ST_Extent` is the *scalar* box of one geometry; `ST_Extent_Agg` is the
 * aggregate over many. Reading the scalar and taking the first row answered a
 * single feature's box, so a dataset spanning three UTM zones presented one,
 * ratified coverage refusal never fired, and every distance in that dataset
 * was measured in whichever zone the first row happened to fall in. Recorded
 * as; this is its repair.
 *
 * The bounds are read as numbers rather than parsed out of text, because the
 * aggregate's text form is polygon WKT, not `BOX(…)` — a one-word substitution
 * would have swapped a wrong answer for an unreadable one. The null check
 * comes before the numeric one for the reason `extent-service.ts` states:
 * `Number(null)` is a perfectly finite zero, so an empty table would otherwise
 * report a real extent at the origin.
 *
 * A table with no geometry cannot be measured, and says so.
 */
async function compileBuffer(
  params: Record<string, unknown>,
  label: string,
  requireName: boolean,
): Promise<CompiledRun> {
  const inputName = str(params, "input");
  const name = str(params, "name");
  if (!inputName) required(label, "input");
  if (requireName && !name) required(label, "name");
  // `typeof`, not coercion: `true` becomes a one-metre buffer, `"500"` and
  // `[500]` become five hundred, and the catalog says this parameter is a
  // number. A value that only looks like one is a malformed request, not a
  // measurement.
  const distance = params.distance;
  if (typeof distance !== "number" || !Number.isFinite(distance) || distance <= 0) {
    throw new ApiError(
      "invalid_request",
      `"distance" must be a positive number of metres on the ground.`,
      400,
    );
  }
  refusePastCeiling("distance", distance);

  const table = inputTable(inputName, "buffer's");
  // A distance: a local projection or a refusal, never a fallback.
  const crs = resolveMeasurementCrs(await extentOf(table, "a buffer"), "distance");
  return {
    sql: bufferSql(table, distance, crs),
    name,
    measurement: {
      crs: { distance: crs.crs },
      fallback: !crs.local,
      assumedCrs: assumedCrsOf([table]),
    },
    bindings: { [table.name.toLowerCase()]: table.file },
  };
}

async function compileMeasureColumns(
  params: Record<string, unknown>,
  label: string,
  requireName: boolean,
): Promise<CompiledRun> {
  const inputName = str(params, "input");
  const name = str(params, "name");
  if (!inputName) required(label, "input");
  if (requireName && !name) required(label, "name");
  const measures = parseMeasures(params.measures);

  const table = inputTable(inputName, "measured");
  const extent = await extentOf(table, "measure columns");
  // **Both halves of the strategy, in one run.** A length is a distance and
  // may not take the area fallback, so a dataset too wide for a local
  // projection is refused for length and answered for area — which is why
  // this operation is a proof operation rather than a convenience.
  const needs = new Set(measures.map((m) => MEASURE_KIND[m]));
  const area = needs.has("area")
    ? resolveMeasurementCrs(extent, "area")
    : undefined;
  const distance = needs.has("distance")
    ? resolveMeasurementCrs(extent, "distance")
    : undefined;

  const crs: Record<string, string> = {};
  if (area) crs.area = area.crs;
  if (distance) crs.distance = distance.crs;

  const columns = await columnsOf(table);
  return {
    sql: measureColumnsSql(
      table,
      measures,
      {
        area: area ?? { crs: "", local: true },
        distance: distance ?? { crs: "", local: true },
      },
      columns.map((c) => c.name),
    ),
    name,
    measurement: {
      crs,
      fallback: area?.local === false,
      assumedCrs: assumedCrsOf([table]),
    },
    bindings: { [table.name.toLowerCase()]: table.file },
  };
}

/** A positive number of ground metres, or the refusal the catalog promises. */
export async function compileOperation(
  operationId: string,
  parameters: Record<string, unknown>,
  options: CompileOptions = {},
): Promise<CompiledRun> {
  const operation = findOperation(operationId);
  const params = parameters ?? {};
  // A dry run produces no dataset, so demanding a name for it would refuse the
  // question "what would this give me?" for want of an answer it never uses.
  const requireName = options.requireName !== false;

  switch (operation.id) {
    case "sql_step": {
      const sql = str(params, "sql");
      const name = str(params, "name");
      if (!sql) required(operation.label, "sql");
      if (requireName && !name) required(operation.label, "name");
      return { sql, name };
    }
    case "spatial_join":
      return compileSpatialJoin(params, operation.label, requireName);
    case "buffer":
      return compileBuffer(params, operation.label, requireName);
    case "measure_columns":
      return compileMeasureColumns(params, operation.label, requireName);
    case "centroid":
    case "convex_hull":
    case "simplify":
    case "dissolve":
    case "group_summarize":
    case "filter_rows":
    case "join_by_key":
    case "clip":
    case "difference":
    case "union":
    case "nearest_join":
    case "filter_by_location":
      return compileCatalogVerb(operation, params, requireName);
    case "h3_cell":
    case "hotspot":
    case "cluster_by_distance":
      return compileStatisticsVerb(operation, params, requireName);
    case "geocode_addresses":
      return compileGeocode(operation, params, requireName);
    case "isochrone":
      return compileIsochrone(operation, params, requireName);
    default:
      throw new ApiError(
        "invalid_request",
        `The ${operation.label} cannot be run yet.`,
        400,
      );
  }
}

/**
 * The verbs added, compiled on the proven mold.
 *
 * **One place, twelve verbs, and no verb resolves its own projection.** Each
 * one reads its inputs from the registry, refuses what it can know is wrong
 * before a job exists, and hands a generator the tables and — where it
 * measures — the CRS this module resolved. That is what makes the sweep
 * possible: a transform outside the shared strategy is a grep rather than a
 * judgement.
 */
async function compileCatalogVerb(
  operation: OperationDef,
  params: Record<string, unknown>,
  requireName: boolean,
): Promise<CompiledRun> {
  const label = operation.label;
  const name = str(params, "name");
  if (requireName && !name) required(label, "name");

  /**
   * The table a declared input names — refused where it is absent, **and where
   * its geometry is not what the input accepts**.
   *
   * The picker filters what it offers, but an API caller is not the picker: a
   * point table sent to Simplify's input, or a point mask to a clip, either
   * succeeded outside the advertised contract or failed after a job existed.
   * The class is checked here, at admission, where the refusal is coded.
   */
  const inputFor = (key: string): DataTable => {
    const named = str(params, key);
    if (!named) required(label, key);
    const table = inputTable(named, key);
    const declared = operation.inputs.find((input) => input.name === key);
    if (declared && !declared.accepts.includes("any")) {
      const held = geometryClassOf(table);
      if (!table.geometryColumn) {
        throw new ApiError(
          "invalid_request",
          `"${table.name}" has no geometry, so it cannot be the ${declared.label.toLowerCase()} of ${label}. This input takes ${declared.accepts.join(", ")}.`,
          400,
        );
      }
      if (held !== null && !declared.accepts.includes(held)) {
        throw new ApiError(
          "invalid_request",
          `"${table.name}" holds ${held} geometry, and the ${declared.label.toLowerCase()} of ${label} takes ${declared.accepts.join(", ")}.`,
          400,
        );
      }
    }
    return table;
  };

  const bindings = (...tables: DataTable[]): Record<string, string> =>
    Object.fromEntries(tables.map((t) => [t.name.toLowerCase(), t.file]));

  switch (operation.id) {
    case "centroid": {
      const table = inputFor("input");
      return { sql: centroidSql(table), name, bindings: bindings(table) };
    }
    case "convex_hull": {
      const table = inputFor("input");
      const groupBy = await fields(table, params.group_by, "grouping column");
      return {
        sql: convexHullSql(table, groupBy),
        name,
        bindings: bindings(table),
      };
    }
    case "simplify": {
      const table = inputFor("input");
      const tolerance = metres(params, "tolerance", label, true)!;
      const crs = await crsFor([table], "simplify");
      return {
        sql: simplifySql(table, tolerance, crs),
        name,
        measurement: {
          crs: { distance: crs.crs },
          fallback: !crs.local,
          assumedCrs: assumedCrsOf([table]),
        },
        bindings: bindings(table),
      };
    }
    case "dissolve": {
      const table = inputFor("input");
      const groupBy = await fields(table, params.group_by, "grouping column");
      const geometry = table.geometryColumn;
      if (!geometry) {
        throw new ApiError(
          "invalid_request",
          `"${table.name}" has no geometry column, so there is nothing to ` +
            `dissolve.`,
          400,
        );
      }
      return {
        sql: dissolveSql(table, geometry, groupBy),
        name,
        bindings: bindings(table),
      };
    }
    case "group_summarize": {
      const table = inputFor("input");
      const groupBy = await fields(table, params.group_by, "grouping column", {
        allowGeometry: false,
      });
      const aggregates = await parseAggregates(table, params.aggregates, await columnsOf(table));
      return {
        sql: groupSummarizeSql(table, groupBy, aggregates),
        name,
        bindings: bindings(table),
      };
    }
    case "filter_rows": {
      const table = inputFor("input");
      const [field] = await fields(table, str(params, "field"), "filter column");
      if (!field) required(label, "field");
      const comparison = (str(params, "comparison") || "equals") as Comparison;
      if (!COMPARISONS.includes(comparison)) {
        throw new ApiError(
          "invalid_request",
          `"${comparison}" is not a comparison this operation offers.`,
          400,
        );
      }
      const raw = params.value;
      const value =
        typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
          ? raw
          : null;
      return {
        sql: filterRowsSql(table, field, comparison, value),
        name,
        bindings: bindings(table),
      };
    }
    case "join_by_key": {
      const left = inputFor("left");
      const right = inputFor("right");
      const [leftKey] = await fields(left, str(params, "left_key"), "left key");
      const [rightKey] = await fields(right, str(params, "right_key"), "right key");
      if (!leftKey) required(label, "left_key");
      if (!rightKey) required(label, "right_key");
      const carry = await fields(right, params.carry, "carried column");
      await refuseCarryCollisions(left, carry, ["join_match_count"]);
      return {
        sql: joinByKeySql(left, right, leftKey, rightKey, carry),
        name,
        bindings: bindings(left, right),
      };
    }
    case "clip": {
      const input = inputFor("input");
      const clip = inputFor("clip");
      return { sql: clipSql(input, clip), name, bindings: bindings(input, clip) };
    }
    case "difference": {
      const input = inputFor("input");
      const erase = inputFor("erase");
      return {
        sql: differenceSql(input, erase),
        name,
        bindings: bindings(input, erase),
      };
    }
    case "union": {
      const left = inputFor("left");
      const right = inputFor("right");
      return { sql: unionSql(left, right), name, bindings: bindings(left, right) };
    }
    case "nearest_join": {
      const left = inputFor("left");
      const right = inputFor("right");
      const carry = await fields(right, params.carry, "carried column");
      // **A collision is refused, not silently renamed.** A left table with
      // its own `name` column and a carried `name` produced two columns of
      // that name, and the engine handed back the carried one as `name_1` —
      // a value under a name nobody asked for. `nearest_distance_m` is
      // reserved for the same reason.
      await refuseCarryCollisions(left, carry, ["nearest_distance_m"]);
      const maxDistance = metres(params, "max_distance", label, false);
      // Both inputs: the nearest feature may lie outside the left's own zone.
      const crs = await crsFor([left, right], "a nearest join");
      return {
        sql: nearestJoinSql(left, right, carry, crs, maxDistance),
        name,
        measurement: {
          crs: { distance: crs.crs },
          fallback: !crs.local,
          assumedCrs: assumedCrsOf([left, right]),
        },
        bindings: bindings(left, right),
      };
    }
    case "filter_by_location": {
      const input = inputFor("input");
      const mask = inputFor("mask");
      const relation = (str(params, "relation") || "intersects") as LocationRelation;
      if (!LOCATION_RELATIONS.includes(relation)) {
        throw new ApiError(
          "invalid_request",
          `"${relation}" is not a relationship this operation offers.`,
          400,
        );
      }
      const needsDistance = relation === "within_distance";
      const distance = metres(params, "distance", label, needsDistance);
      // Only a distance-bearing relationship measures, so only it resolves a
      // projection — and only it can be refused for spanning too much earth.
      const crs = needsDistance
        ? await crsFor([input, mask], "a location filter")
        : { crs: "", local: true };
      return {
        sql: filterByLocationSql(
          input,
          mask,
          relation,
          crs,
          distance,
          params.negate === true,
        ),
        name,
        ...(needsDistance
          ? {
              measurement: {
                crs: { distance: crs.crs },
                fallback: !crs.local,
                assumedCrs: assumedCrsOf([input, mask]),
              },
            }
          : {}),
        bindings: bindings(input, mask),
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

/** The aggregate list a summary takes, refused entry by entry. */
async function parseAggregates(
  table: DataTable,
  value: unknown,
  columnTypes: ColumnType[],
): Promise<{ aggregate: SummaryAggregate; field?: string }[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(
      "invalid_request",
      `"aggregates" must be a non-empty list of what to compute per group.`,
      400,
    );
  }
  const columns = columnTypes.map((c) => c.name);
  const numeric = new Set(
    columnTypes
      .filter((c) => /INT|DECIMAL|DOUBLE|FLOAT|REAL|HUGEINT|NUMERIC/i.test(c.type))
      .map((c) => c.name.toLowerCase()),
  );
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ApiError(
        "invalid_request",
        `Each aggregate must name an aggregate and, except for count, a column.`,
        400,
      );
    }
    const { aggregate, field } = entry as Record<string, unknown>;
    if (
      typeof aggregate !== "string" ||
      !SUMMARY_AGGREGATES.includes(aggregate as SummaryAggregate)
    ) {
      throw new ApiError(
        "invalid_request",
        `"${String(aggregate)}" is not an aggregate this operation offers.`,
        400,
      );
    }
    if (aggregate === "count") return { aggregate: aggregate as SummaryAggregate };
    if (typeof field !== "string") {
      throw new ApiError(
        "invalid_request",
        `The "${aggregate}" aggregate needs the column it works on.`,
        400,
      );
    }
    const column = requireColumn(table, columns, field, "aggregate column");
    // **Refused here, not by the binder.** `sum` over a VARCHAR compiles, mints
    // a job and fails inside the engine — which is the user finding out from a
    // failed run what admission could have told them.
    if (
      (aggregate === "sum" || aggregate === "mean") &&
      !numeric.has(column.toLowerCase())
    ) {
      throw new ApiError(
        "invalid_request",
        `"${column}" is not a numeric column, so it cannot be ${
          aggregate === "sum" ? "summed" : "averaged"
        }. Use count, min or max instead.`,
        400,
      );
    }
    return { aggregate: aggregate as SummaryAggregate, field: column };
  });
}

/**
 * A carried column may not collide with one the left input already has, nor
 * with a column the verb itself writes.
 *
 * **Refused rather than renamed.** Two columns of one name in a `SELECT` come
 * back as `name` and `name_1`, and which is which is the engine's business —
 * so the value a user asked for arrives under a name they did not choose, in a
 * dataset that will be read months later. Found at the cross-model review.
 */
async function refuseCarryCollisions(
  left: DataTable,
  carry: string[],
  reserved: string[],
): Promise<void> {
  if (carry.length === 0) return;
  const existing = new Set(
    (await columnsOf(left)).map((column) => column.name.toLowerCase()),
  );
  for (const name of reserved) existing.add(name.toLowerCase());
  const collides = carry.filter((column) => existing.has(column.toLowerCase()));
  if (collides.length > 0) {
    throw new ApiError(
      "invalid_request",
      `"${collides[0]}" is already a column of "${left.name}", so carrying it ` +
        `across would produce two columns of that name. Rename it on the way ` +
        `in, or leave it out.`,
      400,
    );
  }
}

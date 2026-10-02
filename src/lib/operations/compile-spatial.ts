import { bindingKey } from "./input-ref";
import type { DatasetScope } from "@/lib/query/access";
import { ApiError } from "@/lib/api/errors";
import type { CompiledRun } from "./compile";
import { resolveMeasurementCrs } from "./measurement";
import { assumedCrsOf, carriedFields, columnsOf, extentOf, inputTable, refusePastCeiling, required, str } from "./compile-support";
import { bufferSql, measureColumnsSql, parseMeasures, MEASURE_KIND } from "./metric-verbs";
import { spatialJoinSql, validateSpatialJoin, type Predicate, type SpatialJoinParams } from "./spatial-join";

export async function compileSpatialJoin(
  scope: DatasetScope,
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

  const left = inputTable(scope, leftName, "left");
  const right = inputTable(scope, rightName, "right");

  const join: SpatialJoinParams = {
    left: left.name,
    right: right.name,
    // Absent means the catalog's default rather than a silent failure: the
    // catalog declares one and a caller reading it may reasonably omit it.
    predicate: (str(params, "predicate") || "intersects") as Predicate,
    carry: carriedFields(params.carry),
  };

  const [leftColumns, rightColumns] = await Promise.all([
    columnsOf(scope, left),
    columnsOf(scope, right),
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
export async function compileBuffer(
  scope: DatasetScope,
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

  const table = inputTable(scope, inputName, "buffer's");
  // A distance: a local projection or a refusal, never a fallback.
  const crs = resolveMeasurementCrs(await extentOf(scope, table, "a buffer"), "distance");
  return {
    sql: bufferSql(table, distance, crs),
    name,
    measurement: {
      crs: { distance: crs.crs },
      fallback: !crs.local,
      assumedCrs: assumedCrsOf([table]),
    },
    bindings: { [bindingKey(table)]: table.file },
  };
}

export async function compileMeasureColumns(
  scope: DatasetScope,
  params: Record<string, unknown>,
  label: string,
  requireName: boolean,
): Promise<CompiledRun> {
  const inputName = str(params, "input");
  const name = str(params, "name");
  if (!inputName) required(label, "input");
  if (requireName && !name) required(label, "name");
  const measures = parseMeasures(params.measures);

  const table = inputTable(scope, inputName, "measured");
  const extent = await extentOf(scope, table, "measure columns");
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

  const columns = await columnsOf(scope, table);
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
    bindings: { [bindingKey(table)]: table.file },
  };
}

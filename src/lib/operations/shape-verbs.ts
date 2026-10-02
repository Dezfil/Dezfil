import { tableRef } from "./input-ref";
import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import { backToStored, intoMeasurement, type MeasurementCrs } from "./measurement";

/**
 * The shape verbs: centroid, convex hull, simplify.
 *
 * **None of them resolves a projection.** Simplify is handed a CRS, exactly as
 * the buffer is, so a verb cannot quietly choose its own and distort — which is
 * what would make each verb this spec adds a new place for the same defect.
 *
 * Two of them say something a user would otherwise discover from a wrong
 * result: a centroid can fall outside its own shape, and simplification is
 * per-feature, so borders that used to be shared can separate.
 */

function geometryOf(table: DataTable, verb: string): string {
  if (!table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry column, so ${verb} has nothing to work ` +
        `on.`,
      400,
    );
  }
  return table.geometryColumn;
}

/**
 * Centroid: one point per feature, at the feature's centre of mass.
 *
 * **It is the centroid, not a point on the surface.** For a horseshoe or a
 * ring the centre of mass falls outside the shape itself; substituting a point
 * that is guaranteed inside would be a different measurement under the same
 * name, which is the failure the clustering verb's rename exists to prevent.
 * The verb's description says so, and the output records which it is.
 */
export function centroidSql(table: DataTable): string {
  const geom = ident(geometryOf(table, "a centroid"));
  return `SELECT * EXCLUDE (${geom}), ST_Centroid(t.${geom}) AS ${geom}
FROM ${tableRef(table)} AS t
WHERE t.${geom} IS NOT NULL`;
}

/**
 * Convex hull: the smallest convex shape containing the features.
 *
 * Grouped, it is one hull per group with the count of features it contains;
 * ungrouped, one hull over everything. The count is carried because a hull
 * over one point is a point, and a reader needs to know that is what happened.
 */
export function convexHullSql(table: DataTable, groupBy: string[]): string {
  const geom = ident(geometryOf(table, "a convex hull"));
  const groups = groupBy.map(ident);
  const select = groups.length > 0 ? `${groups.join(", ")}, ` : "";
  const group = groups.length > 0 ? `GROUP BY ${groups.join(", ")}` : "";
  return `SELECT ${select}count(*) AS feature_count,
       ST_ConvexHull(ST_Union_Agg(t.${geom})) AS ${geom}
FROM ${tableRef(table)} AS t
WHERE t.${geom} IS NOT NULL
${group}`;
}

/**
 * Simplify: fewer vertices, within a tolerance in **ground metres**.
 *
 * Measured in the resolved projection and returned in stored coordinates, like
 * every other measured verb. **Topology is not preserved**: the engine
 * simplifies each geometry on its own, so two polygons that shared a border can
 * come out with a gap or an overlap between them. The verb says so rather than
 * letting a user find it in the result.
 *
 * **A geometry simplified to nothing drops its feature** — the overlay
 * ruling: an empty geometry renders as nothing, joins as nothing and counts
 * as one. Keeping them made an absurd tolerance a blank layer asserting the
 * full feature count (browser round); dropping them
 * makes the dry run say what will survive before anything is written.
 */
export function simplifySql(
  table: DataTable,
  toleranceM: number,
  crs: MeasurementCrs,
): string {
  const geom = ident(geometryOf(table, "simplify"));
  const measured = intoMeasurement(`t.${geom}`, crs.crs);
  return `SELECT * FROM (
  SELECT t.* REPLACE (${backToStored(`ST_Simplify(${measured}, ${toleranceM})`, crs.crs)} AS ${geom})
  FROM ${tableRef(table)} AS t
  WHERE t.${geom} IS NOT NULL
) AS s
WHERE NOT ST_IsEmpty(${geom})`;
}

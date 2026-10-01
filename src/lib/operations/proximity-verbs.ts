import { tableRef } from "./input-ref";
import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import { intoMeasurement, type MeasurementCrs } from "./measurement";

/**
 * The proximity verbs: nearest join, filter by location.
 *
 * **Both measure, and neither resolves its own projection.** A maximum
 * distance and a "within" radius are ground metres on terms: measured in a
 * local projection or refused, never in degrees and never on a global
 * equal-area one, which preserves area and would answer a plausible wrong
 * distance.
 */

function geometryOf(table: DataTable, verb: string, role: string): string {
  if (!table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry column, so it cannot be the ${role} of ` +
        `${verb}.`,
      400,
    );
  }
  return table.geometryColumn;
}

/**
 * Nearest join: for each left feature, the nearest right feature.
 *
 * **One row out per left feature, always** — including the ones with nothing
 * near them, which keep their own values and come back with the carried
 * columns empty and their distance null. Dropping them would silently delete
 * features from a user's map, which is the surprise the spatial join was
 * written to avoid.
 *
 * The distance is measured in the resolved projection and reported in metres,
 * so a reader can see *how* near the nearest was rather than trusting it.
 */
export function nearestJoinSql(
  left: DataTable,
  right: DataTable,
  carry: string[],
  crs: MeasurementCrs,
  maxDistanceM: number | null,
): string {
  const leftGeom = ident(geometryOf(left, "a nearest join", "left input"));
  const rightGeom = ident(geometryOf(right, "a nearest join", "right input"));
  const carried = carry
    .map((column) => `near.${ident(column)} AS ${ident(column)}`)
    .join(",\n       ");
  const select = carried ? `${carried},\n       ` : "";
  const leftMeasured = intoMeasurement(`l.${leftGeom}`, crs.crs);
  const rightMeasured = intoMeasurement(`r.${rightGeom}`, crs.crs);
  const bound =
    maxDistanceM === null
      ? ""
      : `\n    WHERE ST_Distance(${leftMeasured}, ${rightMeasured}) <= ${maxDistanceM}`;
  return `SELECT l.*,
       ${select}near.nearest_distance_m
FROM ${tableRef(left)} AS l
LEFT JOIN LATERAL (
  SELECT ${carry.map((c) => `r.${ident(c)}`).join(", ")}${carry.length > 0 ? "," : ""}
         ST_Distance(${leftMeasured}, ${rightMeasured}) AS nearest_distance_m
  FROM ${tableRef(right)} AS r${bound}
  ORDER BY ST_Distance(${leftMeasured}, ${rightMeasured})
  LIMIT 1
) AS near ON TRUE`;
}

/** How a filter-by-location relates its two inputs. Fixed here, so an unknown
 * relationship is a refusal rather than a SQL fragment. */
export const LOCATION_RELATIONS = [
  "intersects",
  "within",
  "contains",
  "within_distance",
] as const;
export type LocationRelation = (typeof LOCATION_RELATIONS)[number];

/**
 * Filter by location: keep the features that stand in a relationship to any
 * feature of another input.
 *
 * **`EXISTS`, not a join**: a feature near three others is kept once, not
 * three times. The negative case — *disjoint* — is the same question with the
 * existence negated, which is why it is a relation rather than a second verb.
 */
export function filterByLocationSql(
  input: DataTable,
  mask: DataTable,
  relation: LocationRelation,
  crs: MeasurementCrs,
  distanceM: number | null,
  /** Keep what does **not** stand in that relationship. Every relation can be
   * negated, and they are not interchangeable: a point on a boundary is
   * neither within the polygon nor disjoint from it. */
  negate = false,
): string {
  const geom = ident(geometryOf(input, "a location filter", "input"));
  const maskGeom = ident(geometryOf(mask, "a location filter", "mask"));
  const predicate = (() => {
    switch (relation) {
      case "intersects":
        return `ST_Intersects(t.${geom}, m.${maskGeom})`;
      case "within":
        return `ST_Within(t.${geom}, m.${maskGeom})`;
      case "contains":
        return `ST_Contains(t.${geom}, m.${maskGeom})`;
      case "within_distance":
        return `ST_Distance(${intoMeasurement(`t.${geom}`, crs.crs)}, ${intoMeasurement(
          `m.${maskGeom}`,
          crs.crs,
        )}) <= ${distanceM ?? 0}`;
    }
  })();
  const exists = negate ? "NOT EXISTS" : "EXISTS";
  return `SELECT t.* FROM ${tableRef(input)} AS t
WHERE ${exists} (
  SELECT 1 FROM ${tableRef(mask)} AS m
  WHERE ${predicate}
)`;
}

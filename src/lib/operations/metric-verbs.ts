import { ApiError } from "@/lib/api/errors";
import { ident } from "@/lib/ingest/ingest";
import type { DataTable } from "@/lib/metadata/tables";
import {
  backToStored,
  intoMeasurement,
  type MeasurementCrs,
} from "./measurement";

/**
 * The two verbs that prove metric truth.
 *
 * **Buffer** is the distance case and **measure columns** is both cases in one
 * run — a length is a distance and may not take the area fallback, while an
 * area may. That is why measure columns is a proof operation and not a
 * convenience: it is the one place in this spec's catalog where the two halves
 * of the strategy meet inside a single statement.
 *
 * Neither generator resolves a CRS. They are handed one, so an operation cannot
 * quietly choose its own and distort — which is what would make every verb adds
 * a new place for the same defect.
 */

/** Every measure a user can ask for, and whether it is a measurement at all. */
export const MEASURES = ["area", "length", "x", "y"] as const;
export type Measure = (typeof MEASURES)[number];

/** Which half of the strategy each measure takes. `x` and `y` take neither:
 * they are the stored coordinates, not measurements, and are named as such. */
export const MEASURE_KIND: Record<Measure, "area" | "distance" | "coordinate"> = {
  area: "area",
  length: "distance",
  x: "coordinate",
  y: "coordinate",
};

/** The column each measure produces, with its unit in the name where it has
 * one — a bare `area` invites the reader to supply their own unit. */
export const MEASURE_COLUMN: Record<Measure, string> = {
  area: "area_m2",
  length: "length_m",
  x: "x",
  y: "y",
};

function requireGeometry(table: DataTable, verb: string): string {
  if (!table.geometryColumn) {
    throw new ApiError(
      "invalid_request",
      `"${table.name}" has no geometry column, so ${verb} has nothing to ` +
        `measure.`,
      400,
    );
  }
  return table.geometryColumn;
}

/**
 * Buffer: a ring standing `distanceM` **ground metres** from each feature.
 *
 * Measured in the resolved projection and returned in stored coordinates, so
 * the result renders and joins with everything else. The geometry column keeps
 * its name — the output is the same features, differently shaped — which is
 * what lets a layer built on the input be pointed at the output unchanged.
 */
export function bufferSql(
  table: DataTable,
  distanceM: number,
  crs: MeasurementCrs,
): string {
  const geom = requireGeometry(table, "a buffer");
  const column = ident(geom);
  const measured = intoMeasurement(`t.${column}`, crs.crs);
  return `SELECT * EXCLUDE (${column}),
       ${backToStored(`ST_Buffer(${measured}, ${distanceM})`, crs.crs)} AS ${column}
FROM ${ident(table.name)} AS t`;
}

/**
 * Measure columns: add a column per chosen measure, keeping every existing one.
 *
 * The area and the length are computed in **different** projections when the
 * fallback fires for the area, which is the whole reason this operation takes
 * two resolutions rather than one.
 */
export function measureColumnsSql(
  table: DataTable,
  measures: Measure[],
  crs: { area: MeasurementCrs; distance: MeasurementCrs },
  /** The input's own column names, so a collision is refused rather than
   * shadowed — `SELECT t.*, … AS area_m2` over a table that already has an
   * `area_m2` produces two columns of that name and the reader gets whichever
   * the engine hands back first. */
  existing: string[] = [],
): string {
  const geom = requireGeometry(table, "measure columns");
  const taken = new Set(existing.map((c) => c.toLowerCase()));
  for (const measure of measures) {
    const column = MEASURE_COLUMN[measure];
    if (taken.has(column.toLowerCase())) {
      throw new ApiError(
        "invalid_request",
        `"${table.name}" already has a column called "${column}", so adding ` +
          `${measure} would produce two columns of that name. Rename or drop ` +
          `it first.`,
        400,
      );
    }
  }
  const column = `t.${ident(geom)}`;

  const expression = (measure: Measure): string => {
    switch (measure) {
      case "area":
        return `ST_Area(${intoMeasurement(column, crs.area.crs)})`;
      case "length":
        // **Perimeter *plus* length, and neither alone.** A polygon's length
        // is zero and a line's perimeter is zero, so a single function answers
        // 0 for half the data it is given — and a zero measurement is the
        // quietest wrong answer there is. Summing them is exact for either,
        // because the other term is genuinely zero.
        return (
          `(ST_Perimeter(${intoMeasurement(column, crs.distance.crs)}) + ` +
          `ST_Length(${intoMeasurement(column, crs.distance.crs)}))`
        );
      // Stored coordinates, not measurements: no projection, no unit, and the
      // column names say so.
      case "x":
        return `ST_X(ST_Centroid(${column}))`;
      case "y":
        return `ST_Y(ST_Centroid(${column}))`;
    }
  };

  const added = measures
    .map((m) => `${expression(m)} AS ${ident(MEASURE_COLUMN[m])}`)
    .join(",\n       ");
  return `SELECT t.*,
       ${added}
FROM ${ident(table.name)} AS t`;
}

export function parseMeasures(value: unknown): Measure[] {
  const raw = Array.isArray(value) ? value : [];
  const chosen = raw.filter((m): m is Measure =>
    (MEASURES as readonly string[]).includes(m as string),
  );
  if (chosen.length === 0 || chosen.length !== raw.length) {
    throw new ApiError(
      "invalid_request",
      `"measures" must be a non-empty list drawn from: ${MEASURES.join(", ")}.`,
      400,
    );
  }
  return [...new Set(chosen)];
}

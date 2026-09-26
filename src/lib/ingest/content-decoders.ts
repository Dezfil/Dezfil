import { GEOMETRY_PROJECTION_NAMES, type GeometryCrs, type GeometryFormat } from "@/lib/geometry-evidence";
import { ident } from "./sql";

/** The engine discards EWKT/EWKB SRIDs: read declarations from the source first. */
export function declarationSql(format: GeometryFormat, column: string): string {
  const text = `trim(CAST(${ident(column)} AS VARCHAR))`;
  if (format === "wkt") {
    return `TRY_CAST(regexp_extract(${text}, '(?i)^SRID\\s*=\\s*([0-9]+)\\s*;', 1) AS BIGINT)`;
  }
  if (format !== "wkb") return "NULL::BIGINT";
  const word = (start: number) =>
    `CASE WHEN substr(${text}, 1, 2) = '01' THEN ${[start + 6, start + 4, start + 2, start].map(p => `substr(${text}, ${p}, 2)`).join(" || ")} ELSE substr(${text}, ${start}, 8) END`;
  return `CASE WHEN (TRY_CAST('0x' || (${word(3)}) AS UBIGINT) & 536870912) != 0 THEN TRY_CAST('0x' || (${word(11)}) AS BIGINT) END`;
}

export function decoderSql(format: GeometryFormat, columns: string[], guardEmptyWkb = false): string {
  const col = ident(columns[0]);
  const text = `CAST(${col} AS VARCHAR)`;
  switch (format) {
    case "wkt": return `TRY(ST_GeomFromText(${text}))`;
    case "geojson": return `TRY(ST_GeomFromGeoJSON(${text}))`;
    case "wkb": {
      // guards the engine's empty-binary failure on the explicit/stored
      // roads. Automatic upload behavior is outside this piece's scope.
      const binary = guardEmptyWkb ? `from_hex(nullif(trim(${text}), ''))` : `from_hex(trim(${text}))`;
      return `TRY(ST_GeomFromWKB(${binary}))`;
    }
    case "h3":
      // Boundary conversion alone accepts invalid indexes; validate first.
      return `CASE WHEN TRY(h3_is_valid_cell(${text})) THEN TRY(ST_GeomFromText(h3_cell_to_boundary_wkt(${text}))) END`;
    case "pair": return `CASE WHEN ${presentSql(columns)} THEN ST_Point(CAST(${col} AS DOUBLE), CAST(${ident(columns[1])} AS DOUBLE)) END`;
  }
}
export function presentSql(columns: string[]): string {
  return columns.map(c => `${ident(c)} IS NOT NULL`).join(" AND ");
}

/** Check every vertex, including inner rings and collection members. Empty
 * geometries have no out-of-range coordinates and retain their identity. */
export function degreeSql(geometry: string): string {
  // A valid geometry has finite vertices, so its extrema give the same
  // inclusive range verdict without expanding every vertex into a Point.
  // Invalid shapes remain acceptable when their coordinates fit: fall back
  // to the original vertex check for them (and for an unavailable validity
  // verdict), including nonfinite coordinates and malformed polygon rings.
  return `CASE WHEN TRY(ST_IsValid(${geometry})) THEN
    coalesce(ST_XMin(${geometry}) >= -180 AND ST_XMax(${geometry}) <= 180
      AND ST_YMin(${geometry}) >= -90 AND ST_YMax(${geometry}) <= 90, true)
    ELSE coalesce(list_bool_and(list_transform(ST_Dump(ST_Points(${geometry})), p ->
    isfinite(ST_X(p.geom)) AND isfinite(ST_Y(p.geom))
    AND ST_X(p.geom) BETWEEN -180 AND 180 AND ST_Y(p.geom) BETWEEN -90 AND 90)), true) END`;
}

/** The full-input placement pass of a reading: how many present values do
 * not decode, how many decoded ones a transform loses, and how many fall
 * outside the degree range before and after placement. `place` wraps a
 * decoded geometry in its transform; null when the geometry is used as
 * decoded. */
export function placementStatsSql(from: string, present: string, decode: string, place: ((geometry: string) => string) | null): string {
  // The column is parsed once, in its own projection; the engine does not
  // share two spellings of the same decode, and a large WKT column's parse
  // is the pass's whole cost. With nothing to place, the placed geometry
  // is the decoded one: no transform can fail and its degree check is the
  // source's, so neither is computed a second time.
  const decoded = `(SELECT ${present} present, ${decode} raw_geometry FROM ${from})`;
  if (place === null) {
    return `SELECT unreadable, 0::BIGINT failed_transform, source_unsafe, source_unsafe unsafe FROM (
    SELECT count(*) FILTER (WHERE present AND raw_geometry IS NULL) unreadable,
      count(*) FILTER (WHERE raw_geometry IS NOT NULL AND NOT (${degreeSql("raw_geometry")})) source_unsafe
    FROM ${decoded})`;
  }
  return `WITH decoded AS (
    SELECT present, raw_geometry, ${place("raw_geometry")} placed_geometry FROM ${decoded}
  ) SELECT count(*) FILTER (WHERE present AND raw_geometry IS NULL) unreadable,
    count(*) FILTER (WHERE raw_geometry IS NOT NULL AND placed_geometry IS NULL) failed_transform,
    count(*) FILTER (WHERE raw_geometry IS NOT NULL AND NOT (${degreeSql("raw_geometry")})) source_unsafe,
    count(*) FILTER (WHERE placed_geometry IS NOT NULL AND NOT (${degreeSql("placed_geometry")})) unsafe
    FROM decoded`;
}

export function crsEvidence(format: GeometryFormat, declarations: number[]): GeometryCrs {
  if (declarations.length > 1) return { stance: "conflicting", srid: null, label: "Conflicting CRS declarations" };
  if (declarations.length === 1) {
    const srid = declarations[0];
    const names = GEOMETRY_PROJECTION_NAMES;
    return { stance: "declared", srid, label: srid === 4326 ? "WGS 84" : names[srid] ? `${names[srid]} (EPSG:${srid})` : `EPSG:${srid}` };
  }
  const inherent = format === "geojson" || format === "h3";
  return { stance: inherent ? "inherent" : "assumed", srid: inherent ? 4326 : null, label: inherent ? "WGS 84" : "WGS 84 assumed" };
}

export function shapedFormats(values: unknown[]): GeometryFormat[] {
  const strings = values.filter((v): v is string => typeof v === "string");
  const formats: GeometryFormat[] = [];
  if (strings.some(v => /^\s*(SRID\s*=|(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*(?:ZM?\s*|M\s*)?(?:\(|EMPTY\b))/i.test(v))) formats.push("wkt");
  if (strings.some(v => /^\s*\{/.test(v))) formats.push("geojson");
  if (strings.some(v => /^\s*(00|01)[0-9a-f]{8,}\s*$/i.test(v))) formats.push("wkb");
  if (strings.some(v => /^8[0-9a-f]{14}$/i.test(v))) formats.push("h3");
  return formats;
}

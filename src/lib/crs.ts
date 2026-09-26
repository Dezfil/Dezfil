/**
 * The one label this instance stores geometry under ('s repair).
 *
 * **Every artifact in this workspace holds WGS84 longitude/latitude** — that
 * is the ingest contract, and `crsAssumed` records where it was assumed rather
 * than declared. What differs is the *label* each path writes: the CSV ingest
 * path and the operation materializer tag geometry `OGC:CRS84`, while GDAL
 * writes `EPSG:4326` for the same coordinates. DuckDB compares the labels
 * before it compares the geometry, so `ST_Intersects` across the two is
 * refused at bind time — and *upload a CSV of stations, upload a GeoJSON of
 * districts, join them* failed on the shipped product.
 *
 * So the canonical label lives here, once, and the registered view is where
 * everything that queries by name meets it.
 */

/** What a registered view presents. Matches `measurement.ts`'s stored CRS,
 * which every transform reads and writes. */
export const CANONICAL_CRS = "EPSG:4326";

/**
 * The labels that mean the same coordinates as the canonical one.
 *
 * **Deliberately a closed list.** Relabelling is not projecting: setting the
 * label on geometry that is genuinely in another projection would move every
 * feature to the wrong place while reporting success. Only labels that are
 * WGS84 longitude/latitude by another name are here, plus the unlabelled case,
 * which is this instance's own storage contract rather than an unknown.
 */
const EQUIVALENT = new Set([
  "OGC:CRS84",
  "CRS:84",
  "EPSG:4326",
  "WGS84",
  "WGS 84",
  "URN:OGC:DEF:CRS:OGC:1.3:CRS84",
]);

/** The CRS named inside a DuckDB geometry type, or null for a bare one. */
export function crsOfGeometryType(columnType: string): string | null {
  const match = /^GEOMETRY\s*\(\s*'?([^')]+?)'?\s*\)$/i.exec(columnType.trim());
  return match ? match[1] : null;
}

/** Whether a column of this type holds canonical coordinates under another
 * name — and may therefore be relabelled rather than transformed. */
export function isCanonicalEquivalent(columnType: string): boolean {
  if (!/^GEOMETRY\b/i.test(columnType.trim())) return false;
  const crs = crsOfGeometryType(columnType);
  // A bare `GEOMETRY` carries no label at all. In this instance that is not an
  // unknown projection: everything stored is WGS84, and leaving it unlabelled
  // is what makes it uncomparable with a labelled neighbour.
  if (crs === null) return true;
  return EQUIVALENT.has(crs.toUpperCase().replace(/\s+/g, " "));
}

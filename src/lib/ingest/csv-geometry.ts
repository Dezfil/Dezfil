/**
 * The documented CSV geometry-recognition rules (spec: Upload). Ingest applies
 * this module directly. OpenAPI carries its own published prose, with the
 * two surfaces held together by the upload contract test.
 *
 * Rules, in precedence order:
 *   1. WKT column — a text column named exactly (case-insensitive) one of
 *      `wkt`, `geometry`, `geom`: parsed as WKT; the text column is replaced
 *      by the resulting geometry column.
 *   2. Coordinate pair — columns named exactly (case-insensitive) one of the
 *      documented longitude/latitude pairs, each numeric or containing only
 *      values the CSV reader parsed as NULL: combined into point geometry.
 *      A pair needing the blank qualification is held and used only when
 *      rule 3 produces no recognition of its own (finding pairs it cannot
 *      choose between does not count as producing one). The original
 *      columns are kept.
 *   3. Prefixed pair — numeric lon/lat columns sharing a name
 *      stem (`origin_lon`/`origin_lat`, `pickup_longitude`/…): the
 *      origin-classified pair — or the only pair, when there is exactly
 *      one — becomes the point geometry, so flow tables land renderable and
 *      arc-ready. The original columns are kept.
 * These are the name rules. Content recognition follows them
 * and full-input CRS/placement checks in the companion modules; a CSV
 * without any eligible mapping imports as a plain non-spatial table.
 */

import { lonLatPairs, stemKind } from "@/lib/od";

export const WKT_COLUMN_NAMES = ["wkt", "geometry", "geom"] as const;

export const COORDINATE_PAIRS: readonly {
  lon: string;
  lat: string;
}[] = [
  { lon: "lon", lat: "lat" },
  { lon: "lng", lat: "lat" },
  { lon: "long", lat: "lat" },
  { lon: "longitude", lat: "latitude" },
];

export interface CsvColumn {
  name: string;
  type: string;
  /** True when this CSV reader relation contains no non-NULL value here. */
  allBlank?: boolean;
}

export type CsvGeometryRecognition =
  | { kind: "wkt"; column: string }
  | { kind: "point"; lon: string; lat: string }
  | null;

const NUMERIC = /^(DOUBLE|FLOAT|REAL|DECIMAL|(U?(TINY|SMALL|BIG|HUGE)?INT))/;

export function isNumericCsvType(type: string): boolean {
  return NUMERIC.test(type);
}

export interface NameMatch {
  columns: string[];
  format: "wkt" | "pair";
  rule: "wkt-name" | "exact-pair" | "prefixed-pair";
}

/** Ordered alternatives, so an unsafe earlier name can yield to the next.
 * Blank exact pairs are held behind productive prefixed selection. */
export function orderedNameMatches(columns: readonly CsvColumn[]): NameMatch[] {
  const byLower = new Map(columns.map(c => [c.name.toLowerCase(), c]));
  const matches: NameMatch[] = [];
  const held: NameMatch[] = [];
  for (const name of WKT_COLUMN_NAMES) {
    const c = byLower.get(name);
    if (c?.type.startsWith("VARCHAR")) matches.push({ columns: [c.name], format: "wkt", rule: "wkt-name" });
  }
  for (const pair of COORDINATE_PAIRS) {
    const lon = byLower.get(pair.lon), lat = byLower.get(pair.lat);
    if (!lon || !lat || ![lon, lat].every(c => isNumericCsvType(c.type) || c.allBlank)) continue;
    const match: NameMatch = { columns: [lon.name, lat.name], format: "pair", rule: "exact-pair" };
    (isNumericCsvType(lon.type) && isNumericCsvType(lat.type) ? matches : held).push(match);
  }
  const pairs = lonLatPairs(columns.filter(c => isNumericCsvType(c.type)).map(c => c.name)).filter(p => p.stem.length > 0);
  const origins = pairs.filter(p => stemKind(p.stem) === "origin");
  const chosen = origins.length === 1 ? origins[0] : pairs.length === 1 ? pairs[0] : null;
  if (chosen) matches.push({ columns: [chosen.lon, chosen.lat], format: "pair", rule: "prefixed-pair" });
  return [...matches, ...held];
}

/** Names-only answer retained for the published rule tests. The ingest planner
 * consumes the same ordered matches, then applies placement/content checks. */
export function recognizeCsvGeometry(columns: readonly CsvColumn[]): CsvGeometryRecognition {
  const match = orderedNameMatches(columns)[0];
  if (!match) return null;
  return match.format === "wkt"
    ? { kind: "wkt", column: match.columns[0] }
    : { kind: "point", lon: match.columns[0], lat: match.columns[1] };
}

/**
 * The suspect-header signals: read from the same detected column names
 * the recognition rules use, advisory only — they never change
 * recognition, admission, or layer eligibility.
 *
 * - Unsplit header: a detected column name CONTAINS A COMMA — the read
 *   never split the line the file's own extension promised was
 * comma-separated (the field find: the whole first line
 *   became one column's name).
 * - Consumed header: MORE THAN HALF of the detected names are blank
 *   after trimming, or are plain base-10 numbers after trimming (an
 *   optional sign, an integer or decimal, nothing else) — the first
 *   data row was taken as the header.
 *
 * Named accepted false positives: a legitimate quoted header name
 * containing a comma; a wide table whose columns are mostly years.
 */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function suspectCsvHeader(
  columns: readonly Pick<CsvColumn, "name">[],
): boolean {
  if (columns.length === 0) return false;
  if (columns.some((c) => c.name.includes(","))) return true;
  const dataLike = columns.filter((c) => {
    const trimmed = c.name.trim();
    return trimmed === "" || PLAIN_NUMBER.test(trimmed);
  }).length;
  return dataLike * 2 > columns.length;
}

/** First identifier not taken by an existing column: geometry, geometry_2, … */
export function geometryColumnName(existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has("geometry")) return "geometry";
  for (let i = 2; ; i++) {
    const candidate = `geometry_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

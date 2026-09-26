/**
 * Origin→destination endpoints. Arc and line visualizations draw each row as
 * an origin→destination pair; an endpoint is either a geometry column of the
 * layer's result or a longitude/latitude pair of numeric columns — flow
 * tables usually arrive as CSVs with four numeric columns.
 *
 * Inference lives here so the builder, the CSV recognition rules, and tests
 * share one set of naming conventions: a result with exactly two geometry
 * columns maps first→origin, second→destination; otherwise columns are
 * matched by name (origin/source/from/start/pickup… vs
 * dest/target/to/end/dropoff…) over geometry fields first, then numeric
 * pairs. Anything ambiguous stays unmapped — the pane asks instead.
 */

export type OdEndpoint =
  | { kind: "geometry"; field: string }
  | { kind: "lonlat"; lon: string; lat: string };

export interface OdColumns {
  geometryColumns: readonly string[];
  numericColumns: readonly string[];
}

export interface OdMapping {
  origin: OdEndpoint;
  dest: OdEndpoint;
}

const ORIGIN_STEM = /^(origin|source|src|from|start|pickup|o)$/i;
const DEST_STEM = /^(dest|destination|target|to|end|dropoff|d)$/i;
const LON_TOKEN = /^(lon|lng|long|longitude|x)$/i;
const LAT_TOKEN = /^(lat|latitude|y)$/i;

function tokens(name: string): string[] {
  return name.split(/[_\-\s]+/).filter(Boolean);
}

export function stemKind(name: string): "origin" | "dest" | null {
  const parts = tokens(name);
  if (parts.some((t) => ORIGIN_STEM.test(t))) return "origin";
  if (parts.some((t) => DEST_STEM.test(t))) return "dest";
  return null;
}

/** A lon-role or lat-role column, with the rest of the name as its stem. */
function coordinateRole(
  name: string,
): { role: "lon" | "lat"; stem: string } | null {
  const parts = tokens(name);
  const lonIndex = parts.findIndex((t) => LON_TOKEN.test(t));
  const latIndex = parts.findIndex((t) => LAT_TOKEN.test(t));
  if (lonIndex !== -1 && latIndex === -1) {
    return {
      role: "lon",
      stem: parts.filter((_, i) => i !== lonIndex).join("_"),
    };
  }
  if (latIndex !== -1 && lonIndex === -1) {
    return {
      role: "lat",
      stem: parts.filter((_, i) => i !== latIndex).join("_"),
    };
  }
  return null;
}

export interface LonLatPair {
  lon: string;
  lat: string;
  /** The shared name stem, e.g. "origin" for origin_lon/origin_lat. */
  stem: string;
}

/** Lon/lat pairs among the numeric columns, matched by shared name stem. */
export function lonLatPairs(numericColumns: readonly string[]): LonLatPair[] {
  const lons = new Map<string, string>();
  const lats = new Map<string, string>();
  for (const name of numericColumns) {
    const coord = coordinateRole(name);
    if (!coord) continue;
    const key = coord.stem.toLowerCase();
    // First column wins per stem+role; duplicates keep the earlier one.
    const bucket = coord.role === "lon" ? lons : lats;
    if (!bucket.has(key)) bucket.set(key, name);
  }
  const pairs: LonLatPair[] = [];
  for (const [stem, lon] of lons) {
    const lat = lats.get(stem);
    if (lat) pairs.push({ lon, lat, stem });
  }
  return pairs;
}

/** Every endpoint a picker can offer: geometry columns, then named pairs. */
export function odCandidates(columns: OdColumns): OdEndpoint[] {
  return [
    ...columns.geometryColumns.map(
      (field): OdEndpoint => ({ kind: "geometry", field }),
    ),
    ...lonLatPairs(columns.numericColumns).map(
      (pair): OdEndpoint => ({ kind: "lonlat", lon: pair.lon, lat: pair.lat }),
    ),
  ];
}

/** Whether the result can express two endpoints at all — the tile gate. */
export function odPossible(columns: OdColumns): boolean {
  return odCandidates(columns).length >= 2;
}

/** The automatic mapping, or null when the user must choose. */
export function inferOd(columns: OdColumns): OdMapping | null {
  const geoms = columns.geometryColumns;
  // Exactly two geometry columns: SELECT order is the mapping.
  if (geoms.length === 2) {
    return {
      origin: { kind: "geometry", field: geoms[0] },
      dest: { kind: "geometry", field: geoms[1] },
    };
  }

  const named = (kind: "origin" | "dest"): OdEndpoint | null => {
    const geometryMatches = geoms.filter((g) => stemKind(g) === kind);
    if (geometryMatches.length === 1) {
      return { kind: "geometry", field: geometryMatches[0] };
    }
    if (geometryMatches.length > 1) return null;
    const pairMatches = lonLatPairs(columns.numericColumns).filter(
      (p) => stemKind(p.stem) === kind,
    );
    if (pairMatches.length === 1) {
      return { kind: "lonlat", lon: pairMatches[0].lon, lat: pairMatches[0].lat };
    }
    return null;
  };

  const origin = named("origin");
  const dest = named("dest");
  return origin && dest ? { origin, dest } : null;
}

export function sameEndpoint(a: OdEndpoint | null, b: OdEndpoint | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "geometry" && b.kind === "geometry") return a.field === b.field;
  if (a.kind === "lonlat" && b.kind === "lonlat") {
    return a.lon === b.lon && a.lat === b.lat;
  }
  return false;
}

export function isValidEndpoint(value: unknown): value is OdEndpoint {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (e.kind === "geometry") {
    return typeof e.field === "string" && e.field.length > 0;
  }
  if (e.kind === "lonlat") {
    return (
      typeof e.lon === "string" &&
      e.lon.length > 0 &&
      typeof e.lat === "string" &&
      e.lat.length > 0
    );
  }
  return false;
}

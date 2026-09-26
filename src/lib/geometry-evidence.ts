/** Serializable recognition evidence; shared by API consumers and record copy. */
export type GeometryFormat = "wkt" | "geojson" | "wkb" | "h3" | "pair";
export interface GeometryCrs {
  stance: "assumed" | "inherent" | "declared" | "unknown" | "conflicting";
  srid: number | null;
  /** The declared source CRS, even though the artifact always holds WGS84. */
  label: string;
}
export interface GeometryCandidate {
  columns: string[];
  format: GeometryFormat;
  signal: "name" | "content";
  rule: "wkt-name" | "exact-pair" | "prefixed-pair" | "content";
  strength: "strong" | "weak";
  sample: { rows: number; nonNull: number; readable: number | null };
  crs: GeometryCrs;
  degreeCompatible: boolean | null;
  reasons: string[];
  orientations?: { lon: string; lat: string }[];
  applied: boolean;
  /** A replaced named-WKT source is historical, not a stored selectable column. */
  sourceRetained: boolean;
}
export interface GeometryRecord {
  columns: string[];
  format: GeometryFormat;
  signal: GeometryCandidate["signal"] | "manual";
  rule: GeometryCandidate["rule"] | "manual";
  crs: GeometryCrs;
  unreadableCount: number;
}
export const GEOMETRY_FORMAT_LABELS: Record<GeometryFormat, string> = {
  wkt: "WKT text", geojson: "GeoJSON", wkb: "WKB hex", h3: "H3 cell", pair: "Coordinate pair",
};

export interface GeometryEvidence {
  geometryRecord?: GeometryRecord | null;
  geometryCandidates?: GeometryCandidate[];
}

/** Absence is meaningful for legacy and non-CSV sources: never reconstruct it. */
export function geometryEvidence(value: GeometryEvidence): GeometryEvidence {
  return value.geometryRecord !== undefined || value.geometryCandidates !== undefined
    ? { geometryRecord: value.geometryRecord ?? null, geometryCandidates: value.geometryCandidates ?? [] }
    : {};
}

/** Shared names for recognition records and the seven drawn projection choices. */
export const GEOMETRY_PROJECTION_NAMES: Record<number, string> = {
  4326: "WGS 84", 3857: "Web Mercator", 25832: "ETRS89 / UTM 32N", 25833: "ETRS89 / UTM 33N",
  3035: "ETRS89 / LAEA Europe", 27700: "British National Grid", 4269: "NAD83",
};

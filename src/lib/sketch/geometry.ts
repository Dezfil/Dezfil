/**
 * The sketch feature contract: what a drawn shape is, and the one
 * structural gate every commit passes — UI and API alike. A sketch feature
 * is a drawn kind plus a geometry in its kind's family: points are Points,
 * lines are LineStrings, and polygon, rectangle, circle and freehand are
 * single-ring Polygons (drawn shapes carry no holes). Validation is
 * structural and budgeted, in the geo-shape mold, so a feature can safely
 * travel through request bodies and SQL literals. This module publishes
 * drawing's own per-feature ceiling — the polygonal import budget in
 * geo-shape.ts is an import-scope rule and stays its own.
 */

export const SKETCH_KINDS = [
  "point",
  "line",
  "polygon",
  "rectangle",
  "circle",
  "freehand",
] as const;

export type SketchKind = (typeof SKETCH_KINDS)[number];

/** The published per-feature vertex ceiling. */
export const SKETCH_MAX_VERTICES = 10_000;

type Position = [number, number];

export interface SketchPointGeometry {
  type: "Point";
  coordinates: Position;
}
export interface SketchLineGeometry {
  type: "LineString";
  coordinates: Position[];
}
export interface SketchPolygonGeometry {
  type: "Polygon";
  /** Exactly one closed exterior ring — drawn shapes have no holes. */
  coordinates: [Position[]];
}
export type SketchGeometry =
  | SketchPointGeometry
  | SketchLineGeometry
  | SketchPolygonGeometry;

export interface SketchFeature {
  kind: SketchKind;
  geometry: SketchGeometry;
}

/** The polygon-family kinds — the ones that hold Polygon geometry, and
 * (for "polygon" and "freehand") the ones that offer vertex handles. */
export function isPolygonKind(kind: SketchKind): boolean {
  return kind !== "point" && kind !== "line";
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function isClosedRing(value: unknown): value is Position[] {
  if (!Array.isArray(value) || value.length < 4) return false;
  if (!value.every(isPosition)) return false;
  const first = value[0] as Position;
  const last = value[value.length - 1] as Position;
  return first[0] === last[0] && first[1] === last[1];
}

export function sketchVertexCount(geometry: SketchGeometry): number {
  if (geometry.type === "Point") return 1;
  if (geometry.type === "LineString") return geometry.coordinates.length;
  return geometry.coordinates[0].length;
}

/**
 * The refusal sentence for a malformed feature, or null when it passes.
 * One home for the sentences so the UI and every route refuse alike.
 */
export function sketchFeatureError(value: unknown): string | null {
  if (typeof value !== "object" || value === null)
    return "A sketch feature is an object with a kind and a geometry.";
  const f = value as { kind?: unknown; geometry?: unknown };
  if (
    typeof f.kind !== "string" ||
    !SKETCH_KINDS.includes(f.kind as SketchKind)
  )
    return `A sketch feature's kind must be one of ${SKETCH_KINDS.join(", ")}.`;
  const kind = f.kind as SketchKind;
  const g = f.geometry as { type?: unknown; coordinates?: unknown } | null;
  if (typeof g !== "object" || g === null)
    return "A sketch feature needs a geometry.";
  if (kind === "point") {
    if (g.type !== "Point" || !isPosition(g.coordinates))
      return "A point needs Point geometry: one [longitude, latitude] pair in range.";
    return null;
  }
  if (kind === "line") {
    if (
      g.type !== "LineString" ||
      !Array.isArray(g.coordinates) ||
      g.coordinates.length < 2 ||
      !g.coordinates.every(isPosition)
    )
      return "A line needs LineString geometry: at least two [longitude, latitude] pairs in range.";
    if (g.coordinates.length > SKETCH_MAX_VERTICES)
      return `A sketch feature holds at most ${SKETCH_MAX_VERTICES.toLocaleString("en-US")} vertices.`;
    return null;
  }
  if (
    g.type !== "Polygon" ||
    !Array.isArray(g.coordinates) ||
    g.coordinates.length !== 1 ||
    !isClosedRing(g.coordinates[0])
  )
    return `A ${kind} needs Polygon geometry: one closed ring of at least four in-range positions, no holes.`;
  if ((g.coordinates[0] as Position[]).length > SKETCH_MAX_VERTICES)
    return `A sketch feature holds at most ${SKETCH_MAX_VERTICES.toLocaleString("en-US")} vertices.`;
  return null;
}

/** Narrow after sketchFeatureError returned null. */
export function asSketchFeature(value: unknown): SketchFeature {
  return value as SketchFeature;
}

function positionText([lng, lat]: Position): string {
  return `${lng} ${lat}`;
}

/** WKT for the writer — one home so the SQL literal never drifts from
 * the validated shape. */
export function sketchGeometryWkt(geometry: SketchGeometry): string {
  if (geometry.type === "Point")
    return `POINT(${positionText(geometry.coordinates)})`;
  if (geometry.type === "LineString")
    return `LINESTRING(${geometry.coordinates.map(positionText).join(", ")})`;
  return `POLYGON((${geometry.coordinates[0].map(positionText).join(", ")}))`;
}

import osmtogeojson from "osmtogeojson";
import type { PolygonPart } from "@/lib/geo-shape";

/**
 * Geometry assembly and class split. The reference library stitches
 * nodes/ways/relations — multipolygons included — and the result splits
 * by geometry class. Feature properties are shaped to a stable schema:
 * OSM id/type, the promoted keys (always present, null when the element
 * lacks them), and ONE stringified `tags` field — tags are never
 * flattened wholesale (roadmap constraint).
 */

export type GeometryClass = "points" | "lines" | "polygons";

export const CLASS_SUFFIX: Record<GeometryClass, string> = {
  points: "points",
  lines: "lines",
  polygons: "polygons",
};

export interface ShapedFeature {
  type: "Feature";
  properties: Record<string, string | null>;
  geometry: unknown;
}

export interface SplitResult {
  points: ShapedFeature[];
  lines: ShapedFeature[];
  polygons: ShapedFeature[];
  total: number;
}

function classOf(geometryType: string): GeometryClass | null {
  switch (geometryType) {
    case "Point":
    case "MultiPoint":
      return "points";
    case "LineString":
    case "MultiLineString":
      return "lines";
    case "Polygon":
    case "MultiPolygon":
      return "polygons";
    default:
      return null;
  }
}

/** One assembled feature as the import lands it: its geometry class and
 * its properties shaped to the stable schema; null for a feature without
 * a geometry of the three classes. */
export function shapeFeature(
  feature: { id?: unknown; properties?: Record<string, unknown> | null; geometry?: { type: string } | null },
  promoted: string[],
): { cls: GeometryClass; shaped: ShapedFeature } | null {
  if (!feature.geometry) return null;
  const cls = classOf(feature.geometry.type);
  if (!cls) return null;

  const props = feature.properties ?? {};
  const tags =
    props.tags && typeof props.tags === "object"
      ? (props.tags as Record<string, unknown>)
      : {};

  const shaped: Record<string, string | null> = {
    osm_id: String(feature.id ?? props.id ?? ""),
    osm_type: typeof props.type === "string" ? props.type : null,
  };
  for (const key of promoted) {
    const value = tags[key];
    shaped[key] = value === undefined || value === null ? null : String(value);
  }
  shaped.tags = JSON.stringify(tags);

  return { cls, shaped: { type: "Feature", properties: shaped, geometry: feature.geometry } };
}

/** Assemble an Overpass JSON response and split it by geometry class. */
export function assembleAndSplit(
  overpassJson: unknown,
  promoted: string[],
): SplitResult {
  const collection = osmtogeojson(overpassJson, { flatProperties: false });
  const result: SplitResult = { points: [], lines: [], polygons: [], total: 0 };

  for (const feature of collection.features) {
    const one = shapeFeature(feature, promoted);
    if (!one) continue;
    result[one.cls].push(one.shaped);
    result.total += 1;
  }
  return result;
}

/** Serialize one class as a GeoJSON FeatureCollection document. */
export function classDocument(features: ShapedFeature[]): string {
  return JSON.stringify({ type: "FeatureCollection", features });
}

/** The selected shape a within-filter applies: a bbox,
 * a drawn ring, or a layer feature's parts — holes honored. */
export type WithinShape =
  | { bbox: [number, number, number, number] }
  | { ring: [number, number][] }
  | { parts: PolygonPart[] };

function pointInRing(
  lng: number,
  lat: number,
  ring: [number, number][],
): boolean {
  // Ray casting; boundary points count as inside.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi === lat && xi === lng) return true;
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function coordsWithin(coords: unknown, shape: WithinShape): boolean {
  if (
    Array.isArray(coords) &&
    coords.length >= 2 &&
    typeof coords[0] === "number" &&
    typeof coords[1] === "number"
  ) {
    const [lng, lat] = coords as [number, number];
    if ("bbox" in shape) {
      const [w, s, e, n] = shape.bbox;
      return lng >= w && lng <= e && lat >= s && lat <= n;
    }
    if ("parts" in shape) {
      return shape.parts.some(
        (part) =>
          pointInRing(lng, lat, part.outer) &&
          !part.holes.some((hole) => pointInRing(lng, lat, hole)),
      );
    }
    return pointInRing(lng, lat, shape.ring);
  }
  if (Array.isArray(coords)) {
    return coords.every((c) => coordsWithin(c, shape));
  }
  return false;
}

/** Entirely-inside test on assembled GeoJSON: every coordinate of the
 * feature lies in the shape. Exact for points and rectangles; for lines
 * and polygons against a concave drawn ring it is the standard
 * vertex-containment approximation. */
export function featureWithin(
  feature: ShapedFeature,
  shape: WithinShape,
): boolean {
  const geometry = feature.geometry as { coordinates?: unknown } | null;
  if (!geometry || geometry.coordinates === undefined) return false;
  return coordsWithin(geometry.coordinates, shape);
}

/** Filter a split result to features entirely inside the shape. */
export function filterSplitWithin(
  split: SplitResult,
  shape: WithinShape,
): SplitResult {
  const points = split.points.filter((f) => featureWithin(f, shape));
  const lines = split.lines.filter((f) => featureWithin(f, shape));
  const polygons = split.polygons.filter((f) => featureWithin(f, shape));
  return {
    points,
    lines,
    polygons,
    total: points.length + lines.length + polygons.length,
  };
}

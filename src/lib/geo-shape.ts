import type { Bbox } from "@/lib/bbox";

/**
 * Polygonal GeoJSON as an import scope: Select from Layer submits a
 * feature's real geometry — Polygon or MultiPolygon, holes and parts
 * intact — and both importers convert it server-side. Validation is
 * structural and budgeted so a geometry can safely travel through request
 * bodies, SQL literals, and stored provenance.
 */

/** Bounds the SQL literal, the Overpass query body, and provenance size. */
export const MAX_GEOMETRY_VERTICES = 20_000;

type Position = [number, number];
type RingCoords = Position[];

export interface PolygonalGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
}

/** One polygon part: the outer boundary and any holes. */
export interface PolygonPart {
  outer: RingCoords;
  holes: RingCoords[];
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

function isRingCoords(value: unknown): value is RingCoords {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isPolygonCoords(value: unknown): value is RingCoords[] {
  return Array.isArray(value) && value.length >= 1 && value.every(isRingCoords);
}

/** Structural check with the vertex budget applied — a geometry this
 * accepts is safe to convert and store. */
export function isPolygonalGeometry(
  value: unknown,
  maxVertices: number = MAX_GEOMETRY_VERTICES,
): value is PolygonalGeometry {
  if (typeof value !== "object" || value === null) return false;
  const g = value as { type?: unknown; coordinates?: unknown };
  const valid =
    g.type === "Polygon"
      ? isPolygonCoords(g.coordinates)
      : g.type === "MultiPolygon"
        ? Array.isArray(g.coordinates) &&
          g.coordinates.length >= 1 &&
          g.coordinates.every(isPolygonCoords)
        : false;
  if (!valid) return false;
  return geometryVertexCount(value as PolygonalGeometry) <= maxVertices;
}

function polygons(geometry: PolygonalGeometry): RingCoords[][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates as RingCoords[]]
    : (geometry.coordinates as RingCoords[][]);
}

export function geometryVertexCount(geometry: PolygonalGeometry): number {
  let n = 0;
  for (const polygon of polygons(geometry))
    for (const ring of polygon) n += ring.length;
  return n;
}

/** The parts, outer ring first per GeoJSON — what the OSM area filter and
 * the within check consume. Coordinates are trimmed to lng/lat. */
export function geometryParts(geometry: PolygonalGeometry): PolygonPart[] {
  return polygons(geometry).map(([outer, ...holes]) => ({
    outer: outer.map(([lng, lat]) => [lng, lat] as Position),
    holes: holes.map((ring) =>
      ring.map(([lng, lat]) => [lng, lat] as Position),
    ),
  }));
}

function closedRing(ring: RingCoords): RingCoords {
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? ring
    : [...ring, first];
}

function ringText(ring: RingCoords): string {
  return `(${closedRing(ring)
    .map(([lng, lat]) => `${lng} ${lat}`)
    .join(", ")})`;
}

/** POLYGON/MULTIPOLYGON WKT, holes preserved, rings closed. */
export function geometryWkt(geometry: PolygonalGeometry): string {
  const parts = polygons(geometry).map(
    (rings) => `(${rings.map(ringText).join(", ")})`,
  );
  return geometry.type === "Polygon"
    ? `POLYGON${parts[0]}`
    : `MULTIPOLYGON(${parts.join(", ")})`;
}

export function geometryBbox(geometry: PolygonalGeometry): Bbox {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const polygon of polygons(geometry))
    for (const ring of polygon)
      for (const [lng, lat] of ring) {
        w = Math.min(w, lng);
        s = Math.min(s, lat);
        e = Math.max(e, lng);
        n = Math.max(n, lat);
      }
  return [w, s, e, n];
}

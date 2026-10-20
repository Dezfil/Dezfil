/** Bounding box helpers for fit-to-bounds (spec: builder brings the viewport
 * to a layer's data extent). Pure geometry, shared by builder and viewer. */

export type Bounds = [[number, number], [number, number]]; // [[w,s],[e,n]]

function walk(coords: unknown, fn: (lng: number, lat: number) => void): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    fn(coords[0], coords[1]);
    return;
  }
  for (const c of coords) walk(c, fn);
}

/** Every position of a geometry, a collection's members included: they
 * keep their geometries rather than coordinates, and are drawn all the
 * same. */
function walkGeometry(geometry: unknown, fn: (lng: number, lat: number) => void): void {
  const g = geometry as { coordinates?: unknown; geometries?: unknown } | null | undefined;
  if (Array.isArray(g?.geometries)) for (const member of g.geometries) walkGeometry(member, fn);
  else walk(g?.coordinates, fn);
}

/** Merge bounds across several GeoJSON feature collections (loosely typed —
 * they come off the render API); null if none have geometry. */
export function boundsOf(collections: unknown[]): Bounds | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  let any = false;
  for (const fc of collections) {
    const features =
      (fc as { features?: unknown })?.features ?? ([] as unknown);
    if (!Array.isArray(features)) continue;
    for (const f of features) {
      walkGeometry((f as { geometry?: unknown })?.geometry, (lng, lat) => {
        any = true;
        if (lng < w) w = lng;
        if (lng > e) e = lng;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      });
    }
  }
  if (!any) return null;
  return [
    [w, s],
    [e, n],
  ];
}

/** Grow bounds by a [west, south, east, north] box — how tiled layers report
 * their extent; their features never reach the client whole. */
export function expandBounds(
  bounds: Bounds | null,
  box: [number, number, number, number],
): Bounds {
  const [w, s, e, n] = box;
  if (!bounds)
    return [
      [w, s],
      [e, n],
    ];
  return [
    [Math.min(bounds[0][0], w), Math.min(bounds[0][1], s)],
    [Math.max(bounds[1][0], e), Math.max(bounds[1][1], n)],
  ];
}

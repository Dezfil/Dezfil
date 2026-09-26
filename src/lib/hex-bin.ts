/**
 * Planar hexagon binning in web-mercator meters. The visual hex bin
 * tessellates the projected plane with pointy-top hexagons of an arbitrary
 * edge length — H3's fixed resolution ladder cannot provide the in-between
 * sizes a map actually needs. The SQL aggregation in query/compile mirrors
 * this exact math; the slider-preview worker uses these functions directly,
 * so preview cells and authoritative cells agree.
 *
 * `edgeM` is the hexagon edge length (= circumradius) in meters — the same
 * number the builder shows as "cell size".
 */

export interface HexCell {
  q: number;
  r: number;
}

const SQRT3 = Math.sqrt(3);
const EARTH_RADIUS_M = 6_378_137;
const MAX_MERCATOR_LAT = 85.0511287798066;

/** [lng, lat] → web-mercator meters (EPSG:3857), latitude clamped. */
export function mercator([lng, lat]: [number, number]): [number, number] {
  const safeLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return [
    (lng * Math.PI * EARTH_RADIUS_M) / 180,
    EARTH_RADIUS_M *
      Math.log(Math.tan(Math.PI / 4 + (safeLat * Math.PI) / 360)),
  ];
}

export function unmercator([x, y]: [number, number]): [number, number] {
  return [
    (x / EARTH_RADIUS_M) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) *
      (180 / Math.PI),
  ];
}

/** The axial cell containing a projected point, via cube rounding. */
export function hexCellAt(x: number, y: number, edgeM: number): HexCell {
  const fq = ((SQRT3 / 3) * x - y / 3) / edgeM;
  const fr = ((2 / 3) * y) / edgeM;
  const fy = -fq - fr;
  let rq = Math.round(fq);
  let ry = Math.round(fy);
  let rr = Math.round(fr);
  const dq = Math.abs(rq - fq);
  const dy = Math.abs(ry - fy);
  const dr = Math.abs(rr - fr);
  if (dq > dy && dq > dr) rq = -ry - rr;
  else if (dy > dr) ry = -rq - rr;
  else rr = -rq - ry;
  return { q: rq, r: rr };
}

export function hexCenter(cell: HexCell, edgeM: number): [number, number] {
  return [SQRT3 * edgeM * (cell.q + cell.r / 2), 1.5 * edgeM * cell.r];
}

/** The cell's boundary as a closed ring (7 vertices, first repeated). */
export function hexBoundary(cell: HexCell, edgeM: number): [number, number][] {
  const [cx, cy] = hexCenter(cell, edgeM);
  const w = (SQRT3 / 2) * edgeM;
  const h = edgeM / 2;
  return [
    [cx, cy + edgeM],
    [cx + w, cy + h],
    [cx + w, cy - h],
    [cx, cy - edgeM],
    [cx - w, cy - h],
    [cx - w, cy + h],
    [cx, cy + edgeM],
  ];
}

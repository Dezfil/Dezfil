import type { Bounds } from "./geo-bounds";

/** Fit's margin around the data, in CSS pixels, and the closest it goes.
 * One value for the builder's Fit and for anything that frames like it. */
export const FIT_PADDING = 64;
export const FIT_MAX_ZOOM = 15;

export interface FitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitCamera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

const TILE_SIZE = 512;
const MAX_LATITUDE = 85.051129;

/** A coordinate in Web Mercator pixels at zoom 0 (a 512 pixel world). */
export function project(lng: number, lat: number): [number, number] {
  const y = Math.min(Math.max(lat, -MAX_LATITUDE), MAX_LATITUDE);
  return [
    ((180 + lng) / 360) * TILE_SIZE,
    ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (y * Math.PI) / 360))) / 360) * TILE_SIZE,
  ];
}

function unproject(x: number, y: number): [number, number] {
  return [
    (x / TILE_SIZE) * 360 - 180,
    (360 / Math.PI) * Math.atan(Math.exp(((180 - (y / TILE_SIZE) * 360) * Math.PI) / 180)) - 90,
  ];
}

export function rotate([x, y]: [number, number], radians: number): [number, number] {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos * x - sin * y, sin * x + cos * y];
}

/**
 * The camera MapLibre's fitBounds lands on for these bounds in a canvas of
 * this size, computed without a map: the same Web Mercator arithmetic
 * (the box rotated by the bearing, the zoom that fits it inside the
 * padding, no closer than the limit, the center shifted by uneven
 * padding), so a host that must know the camera before its map exists
 * frames exactly as Fit does. Like fitBounds, the pitch is applied after
 * the fit and does not enter it. Null when the padding leaves no room.
 */
export function fitCamera(
  bounds: Bounds,
  size: { width: number; height: number },
  padding: FitPadding,
  view: { bearing: number; pitch: number },
  maxZoom: number = FIT_MAX_ZOOM,
): FitCamera | null {
  const [[w, s], [e, n]] = bounds;
  const nw = project(w, n);
  const se = project(e, s);
  const radians = (-view.bearing * Math.PI) / 180;
  const corners = [nw, project(e, n), se, project(w, s)].map((p) => rotate(p, radians));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const availableWidth = size.width - padding.left - padding.right;
  const availableHeight = size.height - padding.top - padding.bottom;
  if (availableWidth < 0 || availableHeight < 0) return null;
  const zoom = Math.min(Math.log2(Math.min(availableWidth / spanX, availableHeight / spanY)), maxZoom);
  const [offsetX, offsetY] = rotate(
    [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2],
    (view.bearing * Math.PI) / 180,
  );
  const scale = 1 / 2 ** zoom;
  const [lng, lat] = unproject((nw[0] + se[0]) / 2 - offsetX * scale, (nw[1] + se[1]) / 2 - offsetY * scale);
  return { lng, lat, zoom, pitch: view.pitch, bearing: view.bearing };
}

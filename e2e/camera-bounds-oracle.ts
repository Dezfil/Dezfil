export type Camera = { lng: number; lat: number; zoom: number; pitch: number; bearing: number };

/** Independent spherical Mercator oracle: no production limits/helpers.
 * Use normalized northing and asinh/sinh, not the renderer's pixel clamp. */
export function coveredCamera(input: Camera, height: number, top = 0, bottom = 0): Camera {
  const zoom = Math.max(input.zoom, -2, Math.log2(height / 512));
  const world = 512 * 2 ** zoom;
  const north = (height + top - bottom) / (2 * world);
  const south = 1 - (height - top + bottom) / (2 * world);
  const latitudeY = 0.5 - Math.asinh(Math.tan(input.lat * Math.PI / 180)) / (2 * Math.PI);
  const y = Math.min(south, Math.max(north, latitudeY));
  return { ...input, zoom, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI };
}

/** Geodesic measurements for the draw tool: edge lengths and
 * ring areas on the sphere, with the agreed rounded formatting — whole
 * km / km², dropping to meters below 1. Pure; shared by the dialog map
 * overlay and its tests. */

const EARTH_RADIUS_KM = 6371.0088;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two [lng, lat] points. */
export function haversineKm(
  a: [number, number],
  b: [number, number],
): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Spherical ring area for [lng, lat] rings, open or closed. Under three
 * distinct points there is no area. */
export function ringAreaKm2(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  if (closed.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < closed.length; i++) {
    const [lng1, lat1] = closed[i];
    const [lng2, lat2] = closed[(i + 1) % closed.length];
    sum += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** "392 km", or "830 m" below one kilometre (rounding agreed 2026-07-20). */
export function formatDistanceKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000).toLocaleString()} m`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** "77,090 km²", or "4,300 m²" below one square kilometre. */
export function formatAreaKm2(km2: number): string {
  if (km2 < 1) return `${Math.round(km2 * 1_000_000).toLocaleString()} m²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

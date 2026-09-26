/** [west, south, east, north] in WGS84 degrees. Shared by import sources
 * and the area-selection UI. */
export type Bbox = [number, number, number, number];

export function isBbox(value: unknown): value is Bbox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    value[0] < value[2] &&
    value[1] < value[3] &&
    value[0] >= -180 &&
    value[2] <= 180 &&
    value[1] >= -90 &&
    value[3] <= 90
  );
}

/** Equirectangular approximation — plenty for budget guards and readouts. */
export function bboxAreaKm2([w, s, e, n]: Bbox): number {
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const widthKm = (e - w) * 111.32 * Math.cos(midLat);
  const heightKm = (n - s) * 110.57;
  return Math.abs(widthKm * heightKm);
}

/**
 * Pure draft geometry: the shapes the overlay commits, kept beside
 * their one ground-distance source so the circle's displayed radius and
 * its stored polygon can never disagree — the ring is built from the
 * same kilometres the readout formats.
 */

export type Ground = [number, number];

/** Segments in a committed circle's ring. */
export const CIRCLE_SEGMENTS = 64;

export function closeRing(positions: Ground[]): Ground[] {
  const [first] = positions;
  const last = positions[positions.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? positions
    : [...positions, first];
}

/** The sphere the readout's haversine uses — one model, so a stored
 * vertex can never disagree with the displayed metres (the
 * flat degree conversion was ~0.1% off, which crosses a metre-rounded
 * readout at sub-kilometre radii). */
const EARTH_RADIUS_KM = 6371.0088;

/** A ground-space circle around its centre: each vertex is the geodesic
 * destination at the ring's radius — exactly the distance the readout
 * formats. */
export function circleRing(centre: Ground, radiusKm: number): Ground[] {
  const [lng, lat] = centre;
  const d = radiusKm / EARTH_RADIUS_KM;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const ring: Ground[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const bearing = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  ring.push(ring[0]);
  return ring;
}

/** The two dragged corners as a closed ground-space ring. */
export function rectangleRing(a: Ground, b: Ground): Ground[] {
  return [a, [b[0], a[1]], b, [a[0], b[1]], a];
}

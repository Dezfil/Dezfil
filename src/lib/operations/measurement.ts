import { ApiError } from "@/lib/api/errors";
import { CANONICAL_CRS } from "@/lib/crs";

/**
 * Where a measurement happens.
 *
 * **Stored geometry is in degrees, and the engine measures in the units it is
 * given.** A buffer of `500` over stored data is five hundred *degrees*; a
 * buffer of `0.0045` is about 500 m north–south and about 305 m east–west at
 * Berlin's latitude — right-looking, wrong, and anisotropic. So every
 * measurement this product makes happens in a projection resolved from the
 * data's own extent, and this module is the only place that resolves one.
 *
 * **The strategy splits by what is being measured, and the split is the point.**
 * An equal-area projection preserves area by distorting distance. One strategy
 * for both would return a plausible wrong radius — which renders, classifies,
 * exports and publishes exactly like a right one, and is the failure this whole
 * spec exists to prevent. So a distance takes a local projection or **refuses**;
 * only an area may fall back to a global equal-area, and the fallback is
 * recorded.
 *
 * **The refusal has to be ours.** The engine does not object to a transform far
 * from a projection's centre: a point 113° away projects happily and returns a
 * plausible-looking coordinate whose distances are stretched past use. Nothing
 * downstream will notice, which is why the width check is made here, before
 * any SQL is generated.
 */

export type MeasurementKind = "distance" | "area";

/** A bounding box in stored coordinates — longitude first, as this repo stores
 * geometry everywhere. */
export interface Extent {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface MeasurementCrs {
  /** The CRS the measurement happens in. */
  crs: string;
  /**
   * False when the global equal-area fallback fired.
   *
   * Recorded in the output's provenance, so a number measured globally is never
   * read back as one measured locally.
   */
  local: boolean;
}

/**
 * The global equal-area projection an **area** may fall back to.
 *
 * NSIDC EASE-Grid 2.0 Global: equal-area, valid worldwide, and named here once
 * so no operation picks its own. A distance may never take it — no global
 * projection preserves distance everywhere, so there is nothing to name.
 */
export const GLOBAL_EQUAL_AREA = "EPSG:6933";

/**
 * The worst distance error a measurement may carry anywhere in its extent.
 *
 * One percent: a five-hundred-metre buffer drawn at most five metres off at
 * the data's far edge, and exact along its middle. Past it the data is too
 * wide for one projection to measure honestly, and the refusal says how to
 * split it.
 */
export const MAX_DISTANCE_ERROR = 0.01;

/** WGS 84's second eccentricity squared, from its flattening 1/298.257223563. */
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * The transverse Mercator's scale factor at a point, with a scale of one on
 * the central meridian, on the WGS 84 ellipsoid.
 *
 * Snyder, *Map Projections: A Working Manual* (USGS Professional Paper 1395,
 * 1987), formula 8-11. A distance measured near the point is longer than on
 * the ground by this factor, so the factor less one is that distance's
 * relative error. It grows away from the central meridian and towards the
 * equator, where a degree of longitude is longest.
 */
export function transverseMercatorScale(latitude: number, offsetFromCentre: number): number {
  const phi = radians(latitude);
  const a = radians(offsetFromCentre) * Math.cos(phi);
  const t = Math.tan(phi) ** 2;
  const c = WGS84_EP2 * Math.cos(phi) ** 2;
  return (
    1 +
    ((1 + c) * a ** 2) / 2 +
    ((5 - 4 * t + 42 * c + 13 * c ** 2 - 28 * WGS84_EP2) * a ** 4) / 24 +
    ((61 - 148 * t + 16 * t ** 2) * a ** 6) / 720
  );
}

/** The latitude in an extent where a degree of longitude is longest: the
 * equator when the extent reaches it, else its edge nearest the equator. */
function widestLatitude(extent: Extent): number {
  if (extent.minLat <= 0 && extent.maxLat >= 0) return 0;
  return Math.min(Math.abs(extent.minLat), Math.abs(extent.maxLat));
}

/**
 * The worst relative distance error anywhere in an extent measured in the
 * transverse Mercator centred on it: the scale factor at its widest point,
 * which is its east or west edge at the latitude nearest the equator.
 */
export function worstDistanceError(extent: Extent): number {
  const halfWidth = (extent.maxLon - extent.minLon) / 2;
  return transverseMercatorScale(widestLatitude(extent), halfWidth) - 1;
}

/** The widest span of longitude, in degrees, that measures within the bound at
 * this extent's latitudes: what each part of a split may span. */
function widestHonestSpan(extent: Extent): number {
  const latitude = widestLatitude(extent);
  let low = 0;
  let high = 90;
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (transverseMercatorScale(latitude, middle) - 1 <= MAX_DISTANCE_ERROR) low = middle;
    else high = middle;
  }
  return 2 * low;
}

function where(extent: Extent): string {
  return (
    `Its extent is longitude ${extent.minLon.toFixed(4)} to ${extent.maxLon.toFixed(4)}, ` +
    `latitude ${extent.minLat.toFixed(4)} to ${extent.maxLat.toFixed(4)}.`
  );
}

function refuse(message: string): never {
  throw new ApiError("measurement_crs_unavailable", message, 400);
}

/** The central meridian a measurement centres on, rounded so the recorded
 * projection reads plainly and reproduces exactly. */
function centralMeridian(extent: Extent): number {
  return Math.round(((extent.minLon + extent.maxLon) / 2) * 1e6) / 1e6;
}

/**
 * The transverse Mercator centred on a meridian, on the WGS 84 ellipsoid, in
 * metres, with a scale of one along that meridian: a PROJ definition the
 * engine transforms into directly and the output's provenance records.
 */
export function transverseMercatorAt(meridian: number): string {
  return (
    `+proj=tmerc +lat_0=0 +lon_0=${meridian} +k=1 +x_0=0 +y_0=0 ` +
    `+datum=WGS84 +units=m +no_defs +type=crs`
  );
}

/**
 * Resolve the CRS a measurement over this extent happens in.
 *
 * **An area is always measured in the global equal-area projection**, which is
 * what the plan's spike answered: measured against the ellipsoid, the global
 * projection is accurate to about 0.001 % at every latitude while a conformal
 * local projection drifts to 0.08 %, because it preserves shape, not area.
 * Both outcomes were pre-ratified, so this is a measured result rather than a
 * decision taken here. One answer everywhere also means a dataset's area does
 * not change meaning as its extent grows.
 *
 * **A distance is measured in a transverse Mercator centred on the data's own
 * extent**, so a city or a country measures wherever it lies: on a fixed
 * zone's edge (Kigali on 30° E, London on 0°), across the equator, or near a
 * pole. It is exact along the extent's middle meridian and longer than the
 * ground towards the east and west edges, so it refuses only an extent too
 * wide to measure honestly: one where a distance at the widest point would be
 * off by more than {@link MAX_DISTANCE_ERROR}, and one that crosses the
 * antimeridian, where the middle of its stored longitudes is the far side of
 * the earth. No global projection preserves distance everywhere, so there is
 * nothing to fall back to.
 */
export function resolveMeasurementCrs(
  extent: Extent,
  kind: MeasurementKind,
): MeasurementCrs {
  if (kind === "area") return { crs: GLOBAL_EQUAL_AREA, local: false };

  const width = extent.maxLon - extent.minLon;
  if (extent.minLon < -180 || extent.maxLon > 180) {
    refuse(
      `This data crosses the antimeridian (longitude 180°), so no one ` +
        `projection centred on it measures a distance in ground metres. ` +
        `${where(extent)} Split it at longitude 180° and measure each side.`,
    );
  }
  if (width > 180) {
    refuse(
      `This data spans ${width.toFixed(1)}° of longitude, more than half the ` +
        `earth, so no one projection centred on it measures a distance in ` +
        `ground metres. Data crossing the antimeridian (longitude 180°) is ` +
        `stored like this too. ${where(extent)} Split it by region, at ` +
        `longitude 180° where it crosses it, and measure each part.`,
    );
  }
  const error = worstDistanceError(extent);
  if (error > MAX_DISTANCE_ERROR) {
    refuse(
      `This data spans ${width.toFixed(1)}° of longitude, too wide to ` +
        `measure a distance over in one projection: at its widest point a ` +
        `distance would be off by ${(error * 100).toFixed(2)} %, and the limit ` +
        `is ${MAX_DISTANCE_ERROR * 100} %. ${where(extent)} Split it by ` +
        `region into parts spanning at most ` +
        `${(Math.floor(widestHonestSpan(extent) * 10) / 10).toFixed(1)}° of longitude each, ` +
        `and measure each part.`,
    );
  }
  return { crs: transverseMercatorAt(centralMeridian(extent)), local: true };
}

/** Parse the engine's own extent text — `BOX(x1 y1, x2 y2)`, longitude first. */
export function parseExtent(text: string): Extent | null {
  const number = String.raw`-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?`;
  const match = new RegExp(
    String.raw`^BOX\(\s*(${number})\s+(${number})\s*,\s*(${number})\s+(${number})\s*\)$`,
  ).exec(text.trim());
  if (!match) return null;
  const [minLon, minLat, maxLon, maxLat] = match.slice(1).map(Number);
  if ([minLon, minLat, maxLon, maxLat].some((n) => !Number.isFinite(n))) return null;
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * A transform between stored coordinates and a measurement CRS.
 *
 * **The axis order is stated in the SQL, every time.** The engine's own switch
 * is unreachable — the hardened instance locks its configuration before serving
 * anything — and its default is documented as due to change, which would make a
 * version bump a silent-result-change event for every measurement. Writing it
 * here is what makes that impossible.
 */
export const STORED_CRS = CANONICAL_CRS;

export function intoMeasurement(expression: string, crs: string): string {
  return `ST_Transform(${expression}, '${STORED_CRS}', '${crs}', always_xy := true)`;
}

export function backToStored(expression: string, crs: string): string {
  return `ST_Transform(${expression}, '${crs}', '${STORED_CRS}', always_xy := true)`;
}

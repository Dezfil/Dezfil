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
 * outside a zone: a point 113° away projects into it happily and returns a
 * plausible-looking coordinate, and so does one beyond the projection's own
 * latitude band. Nothing downstream will notice, which is why the coverage
 * check is made here, before any SQL is generated.
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

/** UTM's own latitude band. Beyond it the zone is not defined. */
const UTM_MAX_LATITUDE = 84;
const UTM_MIN_LATITUDE = -80;

export function utmZone(lon: number): number {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

/** The band of longitudes a zone covers, in stored coordinates. */
function zoneBand(zone: number): { west: number; east: number } {
  const west = -180 + (zone - 1) * 6;
  return { west, east: west + 6 };
}

function refuse(extent: Extent, reason: string): never {
  throw new ApiError(
    "measurement_crs_unavailable",
    `This data spans ${reason}, and no local projection covers it, so a ` +
      `distance measured over it would not be in ground metres. Its extent is ` +
      `longitude ${extent.minLon.toFixed(4)} to ${extent.maxLon.toFixed(4)}, ` +
      `latitude ${extent.minLat.toFixed(4)} to ${extent.maxLat.toFixed(4)}. ` +
      `Split it by region and measure each part.`,
    400,
  );
}

/**
 * Resolve the CRS a measurement over this extent happens in.
 *
 * **An area is always measured in the global equal-area projection**, which is
 * what the plan's spike answered: measured against the ellipsoid, the global
 * projection is accurate to about 0.001 % at every latitude while a local UTM
 * zone drifts to 0.08 % — because UTM is conformal and preserves shape, not
 * area. Both outcomes were pre-ratified, so this is a measured result rather
 * than a decision taken here. One answer everywhere also means a dataset's area
 * does not change meaning when its extent grows across a zone boundary.
 *
 * **A distance takes the local zone or refuses.** No global projection
 * preserves distance everywhere, so there is nothing to fall back to.
 */
export function resolveMeasurementCrs(
  extent: Extent,
  kind: MeasurementKind,
): MeasurementCrs {
  if (kind === "area") return { crs: GLOBAL_EQUAL_AREA, local: false };

  const fallback = (reason: string): MeasurementCrs => refuse(extent, reason);

  if (extent.maxLat > UTM_MAX_LATITUDE || extent.minLat < UTM_MIN_LATITUDE) {
    return fallback("latitudes outside the UTM band");
  }
  // A dataset straddling the equator has no single hemisphere zone: the
  // northern and southern halves of a zone are different projections.
  if (extent.minLat < 0 && extent.maxLat > 0) {
    return fallback("both hemispheres");
  }

  const zone = utmZone((extent.minLon + extent.maxLon) / 2);
  const band = zoneBand(zone);
  if (extent.minLon < band.west || extent.maxLon > band.east) {
    return fallback("more than one UTM zone");
  }

  const northern = extent.maxLat >= 0;
  return { crs: `EPSG:${(northern ? 32600 : 32700) + zone}`, local: true };
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

import { providerCacheGeneration } from "@/lib/provider-cache-generation";
import { ApiError } from "@/lib/api/errors";
import {
  geometryVertexCount,
  geometryWkt,
  isPolygonalGeometry,
  type PolygonalGeometry,
} from "@/lib/geo-shape";
import { haversineKm } from "@/lib/geo-measure";
import { limits } from "@/lib/limits";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote } from "@/lib/net/remote-fetch";
import {
  isochroneCacheKey,
  readIsochrone,
  writeIsochrone,
  type CachedIsochrone,
} from "./cache";
import {
  COSTING_BY_MODE,
  configuredIsochroneEndpoint,
  isochroneEndpointKey,
  isochroneUrl,
} from "./endpoint";
import { takeIsochroneSlot } from "./limiter";
import { settingRemedy } from "@/lib/settings/remedy";

/**
 * One origin, answered.
 *
 * split holds: **a row's failure is a row's business, a transport failure
 * is not.** No route from an origin, or a band the provider did not return,
 * is `unreachable` and the run succeeds. An answer that is not readable,
 * not polygonal, oversized, transposed, or not where travel started is
 * `unreadable_answer` for **every band of that origin** — one response
 * carries them all. The provider not answering at all is retried once and
 * then thrown, which fails the whole run and publishes nothing.
 */

export type BandStatus = "answered" | "unreachable" | "unreadable_answer";

export interface BandAnswer {
  minutes: number;
  status: BandStatus;
  /** The reachable area as WKT in the stored CRS; null unless answered. */
  wkt: string | null;
}

export interface OriginAnswer {
  bands: BandAnswer[];
  /** The candidate the answer was checked against (K8); null when the
   * origin's answer was not accepted. */
  snappedLon: number | null;
  snappedLat: number | null;
  source: "cache" | "wire";
}

/** Bytes of one provider answer this instance will read (K10). */
export const MAX_RESPONSE_BYTES = 4_000_000;
/** Vertices across the whole response (K10). */
export const MAX_RESPONSE_VERTICES = 100_000;
/** How far a snapped candidate may stand from the origin, in kilometres
 * (K8) — generous for a network snap, nowhere near a transposition. */
export const MAX_SNAP_KM = 2;

export interface AskIsochroneOptions {
  signal?: AbortSignal;
  /** When the caller's whole run must be over — honoured on the near side
   * of the slot wait, where the request would otherwise start. */
  deadlineAt?: number;
  /** The endpoint the caller's run was admitted with, kept for its every
   * origin; absent, the endpoint in effect now. */
  endpoint?: string;
  /** The gap between requests the caller's run was admitted with; absent,
   * the gap in effect at the request. */
  gapMs?: number;
  /** The answer time limit the caller's run was admitted with, in
   * milliseconds; absent, the limit in effect at the request. */
  requestTimeoutMs?: number;
}

export function isochroneUnconfiguredError(): ApiError {
  return new ApiError(
    "isochrone_unconfigured",
    "No routing endpoint is configured on this instance, so travel-time " +
      `areas cannot be asked for. ${settingRemedy("isochroneUrl")}`,
    400,
  );
}

/** The provider failed to answer, twice. **The message never names the
 * endpoint**: the configured URL may carry a key, and this text reaches a
 * job record, an API response and a screen. */
function providerFailed(detail: string): ApiError {
  return new ApiError(
    "isochrone_failed",
    `The configured routing endpoint did not answer (${detail}), twice in ` +
      `a row. Nothing was published: an origin nobody could ask about is ` +
      `not an origin that cannot be reached.`,
    502,
  );
}

function pastDeadline(): ApiError {
  return new ApiError(
    "remote_fetch_abandoned",
    "The request was abandoned before it started: the run that asked for " +
      "it had already reached its time bound.",
    499,
  );
}

/** Failures a second attempt cannot repair, and must not disguise. */
function terminal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "egress_blocked" ||
      error.code === "remote_fetch_abandoned" ||
      error.code === "isochrone_unconfigured")
  );
}

function asProviderFailure(error: unknown): ApiError {
  if (error instanceof ApiError && error.code === "isochrone_failed") return error;
  if (error instanceof ApiError && error.code === "remote_fetch_failed") {
    return providerFailed("unreachable");
  }
  return providerFailed("no answer");
}

/* ------------------------------------------------------------------ */
/* Reading the answer                                                  */
/* ------------------------------------------------------------------ */

interface WireFeature {
  type?: unknown;
  properties?: { contour?: unknown; type?: unknown } | null;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
}

/**
 * Every ring closed — checked **before** WKT conversion, because the
 * converter silently closes an open ring, which would repair exactly what
 * the spec says to refuse: a provider that cannot close its own rings
 * is not a provider whose geometry is trusted.
 */
function everyRingClosed(geometry: PolygonalGeometry): boolean {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]);
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return false;
    }
  }
  return true;
}

/** Ray-cast containment over one polygon part set, holes honoured: inside
 * the outer ring and inside no hole. The candidate sits on the earth and
 * the polygon is small; planar even-odd is the honest test here. */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInGeometry(
  lon: number,
  lat: number,
  geometry: PolygonalGeometry,
): boolean {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]);
  for (const [outer, ...holes] of polygons) {
    if (!pointInRing(lon, lat, outer)) continue;
    if (holes.some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/** All of one band's features as one geometry: a single feature keeps its
 * own type; several become a MultiPolygon of every part. */
function combined(features: PolygonalGeometry[]): PolygonalGeometry {
  if (features.length === 1) return features[0];
  const parts: unknown[] = [];
  for (const feature of features) {
    if (feature.type === "Polygon") parts.push(feature.coordinates);
    else parts.push(...(feature.coordinates as unknown[]));
  }
  return { type: "MultiPolygon", coordinates: parts };
}

/** The origin's whole answer failed the checks: every band of it says so. */
function unreadable(bands: number[]): OriginAnswer {
  return {
    bands: bands.map((minutes) => ({
      minutes,
      status: "unreadable_answer",
      wkt: null,
    })),
    snappedLon: null,
    snappedLat: null,
    source: "wire",
  };
}

/**
 * The provider's body, read into one origin's answer (K8).
 *
 * Exported for the criteria's literal fixtures: every check here has a
 * test that states its coordinates in the test. Travel time's Test reads its
 * answer through here too, so it passes only what a run would take.
 */
export function readIsochroneBody(
  text: string,
  origin: { lon: number; lat: number },
  bands: number[],
): OriginAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable(bands);
  }
  // Malformed but parseable — a JSON null, a scalar, a features list holding
  // null — is the provider answering something this instance cannot read: a
  // row fault, never an internal error.
  if (typeof parsed !== "object" || parsed === null) return unreadable(bands);
  const collection = parsed as { features?: unknown };
  if (!Array.isArray(collection.features)) return unreadable(bands);
  const features = (collection.features as unknown[]).filter(
    (feature): feature is WireFeature =>
      typeof feature === "object" && feature !== null,
  );

  // The snapped candidates (K8): `show_locations` returns a MultiPoint of
  // correlated edge candidates plus a separate feature for the input point,
  // told apart by properties.type. An answer with contours but no readable
  // candidate fails closed — the check is the only thing standing between
  // a transposed polygon and a map.
  const candidates: { lon: number; lat: number }[] = [];
  for (const feature of features) {
    if (feature.properties?.type !== "snapped") continue;
    const geometry = feature.geometry;
    if (!geometry || typeof geometry !== "object") continue;
    if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
      for (const position of geometry.coordinates) {
        if (
          Array.isArray(position) &&
          typeof position[0] === "number" &&
          typeof position[1] === "number" &&
          Number.isFinite(position[0]) &&
          Number.isFinite(position[1])
        ) {
          candidates.push({ lon: position[0], lat: position[1] });
        }
      }
    } else if (
      geometry.type === "Point" &&
      Array.isArray(geometry.coordinates) &&
      typeof geometry.coordinates[0] === "number" &&
      typeof geometry.coordinates[1] === "number"
    ) {
      candidates.push({
        lon: geometry.coordinates[0] as number,
        lat: geometry.coordinates[1] as number,
      });
    }
  }

  // Contours are matched by properties.contour, never by position. A
  // returned contour that was not requested is ignored; a requested band
  // with no feature is unreachable — a provider-clamped value is never
  // published under a band the user asked for.
  const byBand = new Map<number, PolygonalGeometry[]>();
  // The vertex budget is the whole response's: an
  // over-budget contour counts against it whether or not it was asked for —
  // the bytes and vertices were sent either way.
  let vertexTotal = 0;
  for (const feature of features) {
    const contour = feature.properties?.contour;
    if (typeof contour !== "number") continue;
    const geometry = feature.geometry;
    if (!bands.includes(contour)) {
      // Unrequested, but its vertices were sent all the same — counted
      // with the per-geometry cap lifted, or an oversized stray would
      // dodge the very budget it breaks.
      if (isPolygonalGeometry(geometry, Number.MAX_SAFE_INTEGER)) {
        vertexTotal += geometryVertexCount(geometry as PolygonalGeometry);
        if (vertexTotal > MAX_RESPONSE_VERTICES) return unreadable(bands);
      }
      continue;
    }
    // Polygonal or nothing: `polygons: true` was mandatory in the request,
    // so a line contour arriving anyway is an answer this instance cannot
    // read — for the whole origin, since one response carries all bands.
    if (!isPolygonalGeometry(geometry, MAX_RESPONSE_VERTICES)) {
      return unreadable(bands);
    }
    const polygonal = geometry as PolygonalGeometry;
    if (!everyRingClosed(polygonal)) return unreadable(bands);
    vertexTotal += geometryVertexCount(polygonal);
    if (vertexTotal > MAX_RESPONSE_VERTICES) return unreadable(bands);
    const list = byBand.get(contour) ?? [];
    list.push(polygonal);
    byBand.set(contour, list);
  }

  if (byBand.size > 0) {
    // K8, held per band: travel starts at one place, so **every**
    // returned band's area must contain a near candidate — one valid band
    // may not vouch for a transposed sibling. The candidate that satisfies
    // all of them is where travel started.
    const areas = [...byBand.values()].map(combined);
    const vouched = candidates.find(
      (candidate) =>
        haversineKm([origin.lon, origin.lat], [candidate.lon, candidate.lat]) <=
          MAX_SNAP_KM &&
        areas.every((area) =>
          pointInGeometry(candidate.lon, candidate.lat, area),
        ),
    );
    if (!vouched) return unreadable(bands);
    return {
      bands: bands.map((minutes) => {
        const features_ = byBand.get(minutes);
        return features_
          ? {
              minutes,
              status: "answered" as const,
              wkt: geometryWkt(combined(features_)),
            }
          : { minutes, status: "unreachable" as const, wkt: null };
      }),
      snappedLon: vouched.lon,
      snappedLat: vouched.lat,
      source: "wire",
    };
  }

  // No requested contour came back at all: every band is unreachable —
  // the provider answered, and its answer is that there is no route.
  return {
    bands: bands.map((minutes) => ({
      minutes,
      status: "unreachable" as const,
      wkt: null,
    })),
    snappedLon: null,
    snappedLat: null,
    source: "wire",
  };
}

/* ------------------------------------------------------------------ */
/* The exchange                                                        */
/* ------------------------------------------------------------------ */

/** What one request to the travel-time service came back with: its status,
 * the body for a 200 or a 400 (null past the cap or unreadable), and how
 * long the exchange took once its slot was taken. */
export interface IsochroneExchange {
  statusCode: number;
  text: string | null;
  milliseconds: number;
}

export interface IsochroneRequestOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Absent, the gap in effect at the request. */
  gapMs?: number;
  /** Absent, the answer time limit in effect at the request. */
  requestTimeoutMs?: number;
  /** What the deadline throws. The engine's own timeout message embeds the
   * URL, which may carry a key; each caller codes its own instead. */
  timeoutError: () => ApiError;
}

/**
 * One area, asked: below the cache, so nothing is looked up or kept. The
 * endpoint's slot is taken first (its gap waited out), the request goes
 * through the outbound engine, and the body is read for a 200 and for a 400
 * (where the protocol says it has no route) and closed otherwise, before the
 * slot is given back. A batch's every ask and the travel-time Test send
 * through here.
 */
export async function requestIsochrone(
  endpoint: string,
  origin: { lon: number; lat: number },
  mode: string,
  bands: number[],
  options: IsochroneRequestOptions,
): Promise<IsochroneExchange> {
  const url = isochroneUrl(endpoint, origin, mode, bands);
  if (!url) throw isochroneUnconfiguredError();
  const { signal, deadlineAt } = options;
  const release = await takeIsochroneSlot(isochroneEndpointKey(endpoint), signal, options.gapMs);
  try {
    const left = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
    if (left !== undefined && left <= 0) throw pastDeadline();
    const limit = options.requestTimeoutMs ?? limits.isochroneRequestTimeoutMs;
    const started = Date.now();
    const response = await openRemote(url.toString(), {
      timeoutMs: left === undefined ? limit : Math.min(limit, left),
      timeoutError: options.timeoutError,
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    const statusCode = response.statusCode;
    if (statusCode === 200) {
      const text = await readCapped(response.body, MAX_RESPONSE_BYTES);
      return { statusCode, text, milliseconds: Date.now() - started };
    }
    if (statusCode === 400) {
      // A 400 may be the provider answering: its body is read (capped) so
      // the caller can tell the protocol's own refusal from a fault.
      const text = await readCapped(response.body, MAX_RESPONSE_BYTES).catch(() => null);
      return { statusCode, text, milliseconds: Date.now() - started };
    }
    // Destroyed, not drained — error headers then a hanging body must not
    // hold this endpoint's one slot open into the retry.
    response.body.destroy();
    return { statusCode, text: null, milliseconds: Date.now() - started };
  } finally {
    release();
  }
}

/**
 * **A structured 400 is the provider answering**: a real Valhalla says "no
 * suitable edges near location" as a 400 with a numeric error_code, and
 * treating that as transport would retry it and fail the whole batch over
 * one off-network origin.
 */
export function isNoRouteAnswer(text: string | null): boolean {
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as { error_code?: unknown };
    return typeof parsed === "object" && parsed !== null && typeof parsed.error_code === "number";
  } catch {
    return false; // Not the protocol's error shape
  }
}

async function askOnce(
  endpoint: string,
  origin: { lon: number; lat: number },
  mode: string,
  bands: number[],
  options: AskIsochroneOptions,
): Promise<string | { noRoute: true } | null> {
  const exchange = await requestIsochrone(endpoint, origin, mode, bands, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
    ...(options.gapMs !== undefined ? { gapMs: options.gapMs } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    // The engine's own timeout message embeds the URL, which may carry a
    // key. Coded here instead.
    timeoutError: () => providerFailed("no answer inside the deadline"),
  });
  if (exchange.statusCode === 200) return exchange.text;
  // The protocol's own refusal is handed to the caller as an answer; every
  // other status is the provider not answering.
  if (exchange.statusCode === 400 && isNoRouteAnswer(exchange.text)) return { noRoute: true };
  throw providerFailed(`status ${exchange.statusCode}`);
}

async function askWithRetry(
  endpoint: string,
  origin: { lon: number; lat: number },
  mode: string,
  bands: number[],
  options: AskIsochroneOptions,
): Promise<string | { noRoute: true } | null> {
  try {
    return await askOnce(endpoint, origin, mode, bands, options);
  } catch (first) {
    if (terminal(first)) throw first;
    try {
      return await askOnce(endpoint, origin, mode, bands, options);
    } catch (second) {
      if (terminal(second)) throw second;
      throw asProviderFailure(second);
    }
  }
}

function fromCache(cached: CachedIsochrone, source: "cache" | "wire"): OriginAnswer {
  return {
    bands: cached.bands.map(({ minutes, wkt }) => ({
      minutes,
      status: "answered" as const,
      wkt,
    })),
    snappedLon: cached.snappedLon,
    snappedLat: cached.snappedLat,
    source,
  };
}

/**
 * The answer for one origin, all bands travelling together: from the cache,
 * or from the wire. **Only a fully answered response is cached** (K10) — a
 * band that failed may succeed tomorrow, and a failure is never cached.
 */
export async function askIsochrone(
  origin: { lon: number; lat: number },
  mode: string,
  bands: number[],
  options: AskIsochroneOptions = {},
): Promise<OriginAnswer> {
  const endpoint = options.endpoint ?? configuredIsochroneEndpoint();
  if (!endpoint) throw isochroneUnconfiguredError();
  const costing = COSTING_BY_MODE[mode];
  const key = isochroneCacheKey(endpoint, costing, origin, bands);
  const generation = providerCacheGeneration();
  const cached = await readIsochrone(key);
  if (cached) return fromCache(cached, "cache");

  const text = await askWithRetry(endpoint, origin, mode, bands, options);
  if (text === null) return unreadable(bands);
  if (typeof text === "object") {
    // The provider's structured refusal: no route from this origin —
    // every band unreachable, the run untouched, nothing cached.
    return {
      bands: bands.map((minutes) => ({
        minutes,
        status: "unreachable" as const,
        wkt: null,
      })),
      snappedLon: null,
      snappedLat: null,
      source: "wire",
    };
  }
  const answer = readIsochroneBody(text, origin, bands);
  if (
    answer.bands.every((band) => band.status === "answered") &&
    answer.snappedLon !== null &&
    answer.snappedLat !== null
  ) {
    await writeIsochrone(key, {
      bands: answer.bands.map(({ minutes, wkt }) => ({ minutes, wkt: wkt! })),
      snappedLon: answer.snappedLon,
      snappedLat: answer.snappedLat,
      answeredAt: new Date().toISOString(),
    }, generation);
  }
  return answer;
}

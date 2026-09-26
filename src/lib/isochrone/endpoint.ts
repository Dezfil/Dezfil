import { createHash } from "node:crypto";

/**
 * The one configured isochrone endpoint.
 *
 * Its own deployment setting, deliberately not the geocoder's: K4 gives
 * this provider its own pace, and a shared setting would be two products
 * behind one URL. The configured URL may carry a credential in its query
 * string — that is where a key travels — so nothing here ever returns it
 * for display, logging or storage; what may be published is the identity,
 * host and path and never the query.
 */

/** The wire shape this product speaks (K1). Part of the cache key, so a
 * protocol revision never serves an old shape's answer as a new one's. */
export const ISOCHRONE_PROTOCOL_VERSION = 1;

/** The configured endpoint exactly as the administrator wrote it, or null. */
export function configuredIsochroneEndpoint(): string | null {
  return process.env.DEZFIL_ISOCHRONE_URL?.trim() || null;
}

export function isochroneConfigured(): boolean {
  return configuredIsochroneEndpoint() !== null;
}

/** The endpoint's identity for keying — a hash, never the URL. The pace and
 * the cache's file names are both keyed by this; a key embedding the URL
 * would put a credential in a directory listing. */
export function isochroneEndpointKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** What may be published about the endpoint: host and path, never the query
 * string — and not a redaction of it either, because a redaction that must
 * never miss is a worse contract than an absence. */
export function isochroneEndpointIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** This product's travel words, mapped to the provider's costing at the
 * boundary (K5) — so a renamed provider profile is this table's edit, not a
 * stored recipe's breakage. */
export const COSTING_BY_MODE: Record<string, string> = {
  driving: "auto",
  walking: "pedestrian",
  cycling: "bicycle",
};

/**
 * The provider's `/isochrone` URL for one origin, all bands travelling
 * together.
 *
 * The configured base keeps its administrator-supplied query parameters (a key
 * travels there), gains the `/isochrone` path segment unless it already ends
 * in one, and the `json` parameter is **set**, never appended beside an
 * existing one. `polygons` and `show_locations` are mandatory: the default
 * contour is a line, which is not an area, and K8's containment check needs
 * to know where travel started. Returns null when unconfigured or
 * unparseable — different administrator mistakes, told apart by
 * `isochroneConfigured`.
 */
export function isochroneUrl(
  origin: { lon: number; lat: number },
  mode: string,
  bands: number[],
): URL | null {
  const raw = configuredIsochroneEndpoint();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/\/isochrone\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/isochrone`;
  }
  url.searchParams.set(
    "json",
    JSON.stringify({
      locations: [{ lon: origin.lon, lat: origin.lat }],
      costing: COSTING_BY_MODE[mode],
      // Valhalla's `time` is already minutes: the number the user typed
      // is the number on the wire, and no conversion exists to test.
      contours: bands.map((minutes) => ({ time: minutes })),
      polygons: true,
      show_locations: true,
    }),
  );
  return url;
}

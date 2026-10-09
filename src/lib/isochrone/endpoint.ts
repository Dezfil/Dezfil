import { createHash } from "node:crypto";
import { addressOrigin, resolveServiceAddress, serviceAddressConfigured } from "@/lib/settings/service-address";

/**
 * The one configured isochrone endpoint.
 *
 * Its own setting, deliberately not the geocoder's: K4 gives
 * this provider its own pace, and a shared setting would be two products
 * behind one URL. The address is the one in effect: the variable when set,
 * else the one an admin stored, else none; a run reads it once and passes
 * it on. The configured URL may carry a credential in its query
 * string — that is where a key travels — so nothing here ever returns it
 * for display, logging or storage; what may be published is the identity,
 * scheme and host alone.
 */

/** The wire shape this product speaks (K1). Part of the cache key, so a
 * protocol revision never serves an old shape's answer as a new one's. */
export const ISOCHRONE_PROTOCOL_VERSION = 1;

/** The endpoint in effect exactly as the administrator wrote it, or null.
 * A stored address the instance's key no longer opens refuses with a coded
 * error instead of answering null. */
export function configuredIsochroneEndpoint(): string | null {
  return resolveServiceAddress("isochroneUrl").address;
}

/** Whether an endpoint is set, an unreadable stored one included. */
export function isochroneConfigured(): boolean {
  return serviceAddressConfigured("isochroneUrl");
}

/** The endpoint's identity for keying — a hash, never the URL. The pace and
 * the cache's file names are both keyed by this; a key embedding the URL
 * would put a credential in a directory listing. */
export function isochroneEndpointKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** What may be published about the endpoint: scheme and host, never its user
 * information, path or query, any of which may carry a key; and not a
 * redaction of them either, because a redaction that must never miss is a
 * worse contract than an absence. */
export function isochroneEndpointIdentity(url: string): string | null {
  return addressOrigin(url);
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
 * together, on the endpoint the caller holds.
 *
 * The configured base keeps its administrator-supplied query parameters (a key
 * travels there), gains the `/isochrone` path segment unless it already ends
 * in one, and the `json` parameter is **set**, never appended beside an
 * existing one. `polygons` and `show_locations` are mandatory: the default
 * contour is a line, which is not an area, and K8's containment check needs
 * to know where travel started. Returns null when the endpoint is
 * unparseable; "no endpoint" is the caller's to tell apart.
 */
export function isochroneUrl(
  endpoint: string,
  origin: { lon: number; lat: number },
  mode: string,
  bands: number[],
): URL | null {
  const raw = endpoint;
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

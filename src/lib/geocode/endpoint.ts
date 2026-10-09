import { createHash } from "node:crypto";
import { addressOrigin, resolveServiceAddress, serviceAddressConfigured } from "@/lib/settings/service-address";

/**
 * The one configured geocoding endpoint, described in one place.
 *
 * A single instance-wide setting was ratified, and two
 * callers now share it: the builder's interactive place search and the batch
 * geocoding operation. Sharing the *setting* while each built its own URL and
 * its own identity would be two conventions for one endpoint — and the pacing
 * ruling (J6) needs them to agree on which endpoint they are talking to, or a
 * limiter keyed one way upholds nothing for a caller keyed the other.
 *
 * The address is the one in effect: the variable when set, else the one an
 * admin stored, else none. A caller that must keep one address across many
 * requests (a batch run) reads it once and passes it on.
 *
 * **The configured URL may carry a credential.** That is deliberate — the query
 * string is where a key travels (J5) — so nothing here ever returns it for
 * display, logging or storage. What may be published is the *identity*: host
 * and path, and never the query.
 */

/** Fixed identifying User-Agent (the public-Nominatim recipe's condition);
 * deliberately not configurable — one setting is ratified. */
export const USER_AGENT =
  "Dezfil self-hosted map builder (+https://github.com/Dezfil/Dezfil)";

/** The endpoint in effect exactly as the administrator wrote it, or null.
 * A stored address the instance's key no longer opens refuses with a coded
 * error instead of answering null. */
export function configuredEndpoint(): string | null {
  return resolveServiceAddress("geocoderUrl").address;
}

/** Whether an endpoint is set, an unreadable stored one included. */
export function geocoderConfigured(): boolean {
  return serviceAddressConfigured("geocoderUrl");
}

/**
 * The endpoint's identity for keying — a hash, never the URL.
 *
 * The pace, and the cache's file names, are both keyed by this. A key that
 * embedded the configured URL would put a credential in a cache directory
 * listing, which is a thing that gets backed up and pasted into an issue.
 */
export function endpointKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * What may be published about the endpoint: its scheme and host.
 *
 * Not its user information, path or query, any of which may carry a key, and
 * not a redaction of them either, because a redaction that must never miss is
 * a worse contract than an absence. An unparseable configuration answers null
 * rather than leaking the raw string into a record.
 */
export function endpointIdentity(url: string): string | null {
  return addressOrigin(url);
}

/**
 * The provider's `/search` URL for one query, on the endpoint the caller holds.
 *
 * The configured base keeps its administrator-supplied query parameters (a key
 * travels there), gains the `/search` path segment unless it already ends in
 * one, and takes the wire-format parameters. Returns null when the endpoint is
 * unparseable — "no endpoint" is the caller's to tell apart, because it and
 * "an endpoint that is not a URL" are different administrator mistakes.
 */
export function searchUrl(
  endpoint: string,
  query: string,
  extra: Record<string, string> = {},
): URL | null {
  const raw = endpoint;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/\/search\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  for (const [key, value] of Object.entries(extra)) {
    url.searchParams.set(key, value);
  }
  return url;
}

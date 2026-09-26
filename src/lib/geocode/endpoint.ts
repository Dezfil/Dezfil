import { createHash } from "node:crypto";

/**
 * The one configured geocoding endpoint, described in one place.
 *
 * A single deployment-wide setting was ratified, and two
 * callers now share it: the builder's interactive place search and the batch
 * geocoding operation. Sharing the *setting* while each built its own URL and
 * its own identity would be two conventions for one endpoint — and the pacing
 * ruling (J6) needs them to agree on which endpoint they are talking to, or a
 * limiter keyed one way upholds nothing for a caller keyed the other.
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

/** The configured endpoint exactly as the administrator wrote it, or null. */
export function configuredEndpoint(): string | null {
  return process.env.DEZFIL_GEOCODER_URL?.trim() || null;
}

export function geocoderConfigured(): boolean {
  return configuredEndpoint() !== null;
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
 * What may be published about the endpoint: its host and path (J5).
 *
 * Not the query string, which is where a key travels — and not a redaction of
 * it either, because a redaction that must never miss is a worse contract than
 * an absence. An unparseable configuration answers null rather than leaking the
 * raw string into a record.
 */
export function endpointIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The provider's `/search` URL for one query.
 *
 * The configured base keeps its administrator-supplied query parameters (a key
 * travels there), gains the `/search` path segment unless it already ends in
 * one, and takes the wire-format parameters. Returns null when unconfigured or
 * unparseable — which the caller tells apart with `geocoderConfigured`, because
 * "no endpoint" and "an endpoint that is not a URL" are different administrator
 * mistakes.
 */
export function searchUrl(
  query: string,
  extra: Record<string, string> = {},
): URL | null {
  const raw = configuredEndpoint();
  if (!raw) return null;
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

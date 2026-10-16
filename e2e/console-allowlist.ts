// Console-error allowlist for the browser journey.
//
// The journey fails on ANY console error not accounted for here. Two kinds
// of allowance exist, and both must stay reviewable:
//
// 1. Offline noise — the journey blocks every non-local host by design
//    (plan: determinism by construction), so the browser logs resource
//    failures for basemap styles/tiles/sprites. The product's handling of
//    that state (the offline fallback badge) is asserted positively by the
//    journey; the browser's own failure lines about blocked hosts are the
//    expected shadow of the setup, recognized by origin rather than listed
//    one URL at a time.
//
// 2. Explicit patterns — anything else we decide to tolerate goes in the
//    list below WITH A REASON. Keep it short; an entry here is a product
//    smell until proven otherwise. (The long-known basemap sprite warning
//    is a console *warning*, not an error, so it needs no entry — the
//    journey only polices errors.) An entry may carry a `url` as well: then
//    the pattern must match the message AND the url must match the failed
//    resource, so a status is tolerated on one route rather than anywhere.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const allowedErrorPatterns: { pattern: RegExp; url?: RegExp; reason: string }[] = [];

function firstUrlIn(text: string): string | undefined {
  return /https?:\/\/[^\s'")]+/.exec(text)?.[0];
}

function isNonLocalUrl(candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    return !LOCAL_HOSTNAMES.has(new URL(candidate).hostname);
  } catch {
    return false;
  }
}

/** True when a console error is expected under the journey's rules. */
export function isAllowedConsoleError(
  text: string,
  resourceUrl?: string,
): boolean {
  if (isNonLocalUrl(resourceUrl) || isNonLocalUrl(firstUrlIn(text))) {
    return true; // offline noise from a deliberately blocked host
  }
  // Resource failures carry their URL out-of-band, not in the message —
  // patterns match either.
  return allowedErrorPatterns.some(({ pattern, url }) =>
    url === undefined
      ? pattern.test(text) || (resourceUrl !== undefined && pattern.test(resourceUrl))
      : pattern.test(text) && resourceUrl !== undefined && url.test(resourceUrl),
  );
}

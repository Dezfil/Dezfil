/**
 * The render browser's egress gate. The export renderer drives headless
 * Chromium at the app's own render route; a custom basemap style makes
 * that page load third-party URLs of the author's choosing — root style,
 * TileJSON, sprites, glyphs, tiles, and anything a redirect introduces.
 * Every request the page makes is admitted here: the app's own origin
 * passes untouched, data/blob stay local by construction, and every
 * other destination has its hostname resolved in Node and checked
 * against the same private-range denial the egress policy encodes
 * (semantics — the allowlist names exceptions).
 *
 * Honest residual, recorded not claimed away: admission resolves DNS in
 * Node while Chromium resolves again for the connection, so a rebinding
 * window exists between the two lookups. The connect-path validation the
 * server's own fetches get has no in-process equivalent inside Chromium;
 * closing it fully would take a local egress proxy.
 */

import { admitRenderHost, type RenderResolver } from "./render-address";

/**
 * Three verdicts, deliberately: "deny" is a POLICY
 * refusal and becomes the coded export failure; "unresolvable" is an
 * ordinary dead hostname — the request is failed without a connection
 * (never continued: an attacker's DNS could answer NXDOMAIN to Node and
 * a private address to Chromium), so the page reaches its dead-style
 * state and that wording is what the image bakes in.
 */
export type GuardVerdict = "allow" | "deny" | "unresolvable";

/** Decide a single page request. Pure over its resolver — unit-testable
 * without a browser or real DNS. */
export async function admitRenderRequest(
  requestUrl: string,
  appOrigin: string,
  resolve?: RenderResolver,
): Promise<GuardVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return "deny";
  }
  // The page's own app requests (the render route, layer data, fonts).
  if (parsed.origin === appOrigin) return "allow";
  // Local-by-construction schemes carry no network destination.
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
    return "allow";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "deny";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return (await admitRenderHost(host, resolve)).verdict;
}

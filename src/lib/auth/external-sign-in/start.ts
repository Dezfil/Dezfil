import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { AuthError } from "../errors";
import { assertRequestOrigin, authFailure, privateResponse, requestIngress } from "../http";
import { sessionCookieName } from "../session-cookie";
import type { Ingress } from "../ingress.mjs";
import { externalSignIn } from "./config";

export const START_LIFETIME_MS = 10 * 60_000;
export const startCookieName = () => `${sessionCookieName()}_start`;
const KEY = Symbol.for("dezfil.external-sign-in-start-key");
function sign(payload: string) {
  const host = process as typeof process & { [KEY]?: Buffer };
  return createHmac("sha256", host[KEY] ??= randomBytes(32)).update(payload).digest();
}
export function makeStart(now = Date.now()) {
  const value = randomBytes(32).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ value, issuedAt: now })).toString("base64url");
  return { value, cookie: `${payload}.${sign(payload).toString("hex")}` };
}
/** No start is retained on the server, including after an abandoned redirect. */
export function readStart(cookie: string | null, now = Date.now()): string | null {
  if (!cookie || cookie.length > 1024) return null;
  const [payload, signature, extra] = cookie.split(".");
  if (!payload || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature ?? "")) return null;
  if (!timingSafeEqual(sign(payload), Buffer.from(signature, "hex"))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!value || typeof value.value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.value) ||
      !Number.isSafeInteger(value.issuedAt) || value.issuedAt > now || value.issuedAt + START_LIFETIME_MS <= now) return null;
    return value.value as string;
  } catch { return null; }
}
export function requestStart(request: Request): string | null {
  const name = `${startCookieName()}=`;
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(name));
  return cookies.length === 1 ? cookies[0].slice(name.length) : null;
}
export function startCookie(response: Response, value: string, ingress: Ingress): void {
  // Response is also used for refusals, so append without replacing another cookie.
  response.headers.append("set-cookie", `${startCookieName()}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? START_LIFETIME_MS / 1000 : 0}${ingress.secure ? "; Secure" : ""}`);
}
export function startExternalSignIn(request: Request): Response {
  try {
    const mode = externalSignIn();
    if (!mode.enabled) throw new AuthError("not_found", "External sign-in is not configured.", 404);
    const ingress = requestIngress(request); assertRequestOrigin(request);
    const start = makeStart(), destination = new URL(mode.doorUrl);
    destination.searchParams.set("start", start.value);
    const response = privateResponse(NextResponse.redirect(destination, 303));
    response.headers.set("referrer-policy", "no-referrer");
    startCookie(response, start.cookie, ingress);
    return response;
  } catch (error) { return authFailure(error); }
}

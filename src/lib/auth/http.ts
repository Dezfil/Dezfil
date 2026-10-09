import { smallJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { errorResponse } from "@/lib/api/errors";
import { authenticateSession, type AuthContext } from "./credentials";
import { authenticateBearer } from "./delegation";
import { requireIngress, type Ingress } from "./ingress.mjs";
import { AuthError, AuthenticationCancelled } from "./errors";
import { securitySettings } from "./security-settings";

export const SESSION_COOKIE = "dezfil_session";
export function privateResponse<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}
export function requestIngress(request: Pick<Request, "headers">): Ingress {
  try { return requireIngress(request.headers); }
  catch { throw new AuthError("ingress_unavailable", "The instance cannot accept sign-ins yet.", 503); }
}
export function sessionSecret(request: Request): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(`${SESSION_COOKIE}=`));
  return values.length === 1 ? values[0].slice(SESSION_COOKIE.length + 1) : null;
}
export function requestAuth(request: Request, db?: Database): AuthContext | null {
  requestIngress(request);
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    return match ? authenticateBearer(match[1], db ?? metadataDb()) : null;
  }
  const secret = sessionSecret(request);
  return secret ? authenticateSession(secret, db ?? metadataDb()) : null;
}
export function requireRequestAuth(request: Request, db?: Database): AuthContext {
  if (!request.headers.has("authorization") && !sessionSecret(request)) {
    requestIngress(request);
    throw new AuthError("authentication_required", "Sign in to continue.", 401);
  }
  // Reject cookie-origin failures before even rolling the presented session.
  if (!request.headers.has("authorization")) assertRequestOrigin(request);
  const context = requestAuth(request, db);
  if (!context) throw new AuthError("authentication_required", "Sign in to continue.", 401);
  const expectedAccount = request.headers.get("x-dezfil-account");
  if (expectedAccount !== null && expectedAccount !== context.account.id) {
    throw new AuthError("authentication_required", "Sign in to continue.", 401);
  }
  assertRequestOrigin(request, context);
  return context;
}
/**
 * How a request's origin is held. A change, the default, needs a cookie
 * request to carry this instance's Origin; a read passes. A protected read
 * is a read whose work this server does when asked, so a cookie request
 * must show it comes from this instance: an Origin that is this
 * instance's, or, with no Origin, the browser's own `Sec-Fetch-Site:
 * same-origin`; a link or a form on another site carries the cookie and
 * neither. A token, and the assistant's delegated request, call directly
 * in either mode.
 */
export type OriginMode = "change" | "protected_read";

export function assertRequestOrigin(request: Request, context?: AuthContext, mode: OriginMode = "change"): void {
  if (mode === "change" && ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (context?.credential.kind === "token" || context?.delegationExpiresAt !== undefined) return;
  const origin = request.headers.get("origin");
  const sameOrigin = origin === null && mode === "protected_read"
    ? request.headers.get("sec-fetch-site") === "same-origin"
    : origin === requestIngress(request).origin;
  if (!sameOrigin) {
    throw new AuthError("forbidden", "This request must come from the same instance.", 403);
  }
}
/** The cookie lives as long as the session it carries: every issue and use
 * sets the session's expiry the stored length ahead, and the cookie with it. */
export function sessionCookie(response: NextResponse, secret: string, ingress: Ingress, clear = false): void {
  response.cookies.set(SESSION_COOKIE, clear ? "" : secret, { httpOnly: true, sameSite: "lax", secure: ingress.secure,
    path: "/", maxAge: clear ? 0 : securitySettings().sessionMs / 1000 });
}
export function authFailure(error: unknown): Response {
  if (error instanceof AuthenticationCancelled) return privateResponse(new Response(null, { status: 499 }));
  if (!(error instanceof AuthError)) return privateResponse(errorResponse(error));
  const response = NextResponse.json({ error: { code: error.code, message: error.message, ...error.extra } }, { status: error.status });
  if (error.code === "rate_limited" || error.code === "authentication_busy") response.headers.set("retry-after", String(error.extra.retryAfter));
  return privateResponse(response);
}
export async function authBody(request: Request, fields: readonly string[], required = fields): Promise<Record<string, string>> {
  const value: unknown = await smallJsonValue(request, () => null);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AuthError("invalid_request", "Expected a JSON body.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.entries(value).some(([key, item]) => !fields.includes(key) || typeof item !== "string") ||
      required.some(key => typeof (value as Record<string, unknown>)[key] !== "string")) {
    throw new AuthError("invalid_request", "Enter the required account details.", 400);
  }
  return value as Record<string, string>;
}

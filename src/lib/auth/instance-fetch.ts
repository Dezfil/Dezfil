import type { AuthContext } from "./credentials";
import { authenticateBearer, delegateSession } from "./delegation";
import { AuthError } from "./errors";
import { authFailure } from "./http";

/** Keep the caller's bearer; a cookie becomes a short-lived session delegation.
 * This value belongs only in transport closures, never model or parked state. */
export function loopbackCredential(request: Request, context: AuthContext): string {
  const authorization = request.headers.get("authorization");
  if (authorization) return authorization.slice(authorization.indexOf(" ") + 1);
  return delegateSession(context);
}

/** Every dispatch rechecks the parent and confines credentials to this origin.
 * API self-calls do not follow redirects, including same-origin redirects. */
export function instanceFetch(baseUrl: string, credential: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password) throw new Error("The request is outside this instance.");
    if (!authenticateBearer(credential)) return authFailure(new AuthError("authentication_required", "Sign in to continue.", 401));
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${credential}`);
    const response = await fetchImpl(input, { ...init, headers, credentials: "omit", cache: "no-store", redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error("The instance API redirected the request.");
    }
    return response;
  };
}

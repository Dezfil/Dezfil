import type { AuthContext } from "./credentials";
import { delegateCredential } from "./delegation";
import { authFailure } from "./http";

/** Every dispatch mints a short-lived bearer from the still-valid parent.
 * Keep the context only in transport closures, never model or parked state.
 * API self-calls do not follow redirects, including same-origin redirects. */
export function instanceFetch(baseUrl: string, context: AuthContext, fetchImpl: typeof fetch = fetch): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password) throw new Error("The request is outside this instance.");
    let credential: string;
    try { credential = delegateCredential(context); } catch (error) { return authFailure(error); }
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

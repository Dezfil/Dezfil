import { isAnonymousOperation } from "@/lib/auth/request-policy";
import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE } from "./openapi-helpers";

type Operation = { security?: typeof AUTH_SECURITY; responses: Record<string, unknown> };
/** Apply the very same anonymous policy as the request gate. */
export function withRequestPolicy<T extends { paths: Record<string, Record<string, Operation>> }>(document: T): T {
  for (const [pathname, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const anonymous = isAnonymousOperation(pathname, method.toUpperCase());
      operation.security = anonymous ? [] : AUTH_SECURITY;
      if (!anonymous) operation.responses = { ...operation.responses, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE };
    }
  }
  return document;
}

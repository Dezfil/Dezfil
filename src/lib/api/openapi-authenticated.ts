import { AUTH_SECURITY } from "./openapi-auth";
import { ERROR_RESPONSE, op } from "./openapi-helpers";

/** Account-bound transports share credential and privacy declarations. */
export function authenticatedOp(config: Parameters<typeof op>[0]) {
  return { ...op({ ...config,
    description: "Requires a current cookie session or bearer token. Cookie mutations require the same trusted Origin. Responses, including refusals, are private, no-store. " + (config.description ?? ""),
    responses: { ...config.responses, "401": ERROR_RESPONSE, "403": ERROR_RESPONSE, "503": ERROR_RESPONSE },
  }), security: AUTH_SECURITY };
}

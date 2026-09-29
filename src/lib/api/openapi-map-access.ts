import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Map operations share the same private identity boundary on every client. */
export function mapAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Map results and changes are limited to the authenticated account's own maps. Administrators have the same boundary. Hidden and missing map or project identities both return not_found before source access or protected changes. " + (config.description ?? ""),
    responses: { "404": ERROR_RESPONSE, ...config.responses },
  };
}

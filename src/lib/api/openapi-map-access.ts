import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Map operations share the same reach boundary on every client. */
export function mapAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "A map is reached by its owner and, while it is filed in a project, by that project's owner and people. Results cover exactly the reached maps and name each map's owner and SQL home; the map's SQL is evaluated in its home within the caller's own reach. Content changes are open to the owner, the project's owner and its editors; deletion, publication settings, snapshots, sketches and duplication stay the owner's. Administrators reach nothing more. Unreached and missing map or project identities both return not_found before source access or protected changes; a reached map whose change the caller may not make returns forbidden and changes nothing. " + (config.description ?? ""),
    responses: { "404": ERROR_RESPONSE, ...config.responses },
  };
}

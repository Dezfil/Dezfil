import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Map operations share the same reach boundary on every client. */
export function mapAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "A map is reached by its owner and, while it is filed in a project, by that project's owner and people. Results cover exactly the reached maps and name each map's owner and SQL home; the map's SQL is evaluated in its home within the caller's own reach. Content changes are open to the owner, the project's owner and its editors; SQL anyone but the owner saves, directly or by undo and redo, must name only datasets within their own reach in the map's home, else it is refused with sql_error naming the reference as written and nothing changes. Sketches drawn on the map are content, each sketch dataset its drawer's own; deletion, publication settings and snapshot captures stay the owner's; a snapshot is served to everyone who reaches the map and every dataset it drew. Anyone who reaches a map may duplicate it into their own space: the copy keeps the map's SQL home and its layers' SQL as stored, is filed in the map's project only when the duplicator may file there (its owner or an editor), and carries the snapshot only when the duplicator may be served it. Administrators reach nothing more. Unreached and missing map or project identities both return not_found before source access or protected changes; a reached map whose change the caller may not make returns forbidden and changes nothing. " + (config.description ?? ""),
    responses: { "404": ERROR_RESPONSE, ...config.responses },
  };
}

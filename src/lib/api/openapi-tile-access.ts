import type { op } from "./openapi-helpers";
export function tileAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Private render results, tile status and archive bytes follow the layer's map owner, including for administrators. Hidden and missing layers return the same not_found before archive reads or build admission. Private tile workers recheck account activity before export and on both sides of archive publication; deactivation leaves no new authoritative archive. Private reads recheck authority before answering. Deleting an owned layer fences its outstanding build. Reactivation permits a fresh build. A visible published layer uses its current token independently of the publisher's activity; a revoked token cannot authorize a new archive. " + (config.description ?? ""),
  };
}

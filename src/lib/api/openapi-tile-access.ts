import type { op } from "./openapi-helpers";
export function tileAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Render results follow the layer's map: everyone who reaches it reads them, evaluated in the map's SQL home within their own reach. Tile status and archive bytes are the map owner's alone, including for administrators; an over-cap layer read by anyone else answers render_cap_exceeded, its tiles drawn for the owner only. Unreached and missing layers return the same not_found before archive reads or build admission. Private tile workers recheck account activity before export and on both sides of archive publication; deactivation leaves no new authoritative archive. Private reads recheck authority before answering. Deleting an owned layer fences its outstanding build. Reactivation permits a fresh build. A visible published layer uses its current token independently of the publisher's activity; a revoked token cannot authorize a new archive. " + (config.description ?? ""),
  };
}

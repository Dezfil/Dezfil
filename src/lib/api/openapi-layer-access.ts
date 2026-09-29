import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Layer identities inherit the owning map's private access boundary. */
export function layerAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Private layers and widgets are limited to the authenticated account's own maps, including for administrators. Hidden, missing or mismatched parent/child identities return not_found before query evaluation, artifact access or protected changes. New widget, timeline and layer-order references must belong to the exact map. " + (config.description ?? ""),
    responses: { "404": ERROR_RESPONSE, ...config.responses },
  };
}

import { ERROR_RESPONSE, type op } from "./openapi-helpers";

/** Layer identities follow their map's reach boundary. */
export function layerAccess(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "Layers and widgets follow their map: everyone who reaches the map reads and evaluates them, and its owner, the project's owner and its editors change them. Layer SQL saved by anyone but the map's owner must name only datasets within their own reach in the map's home, else it is refused with sql_error naming the reference as written and nothing changes. Unreached, missing or mismatched parent/child identities return not_found before query evaluation, artifact access or protected changes. New widget, timeline and layer-order references must belong to the exact map. " + (config.description ?? ""),
    responses: { "404": ERROR_RESPONSE, ...config.responses },
  };
}

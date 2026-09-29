import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function mapChildren(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "History and thumbnails inherit the map owner's private access. Replay checks every target and parent reference before changing the whole gesture; hidden, missing or mismatched references return not_found and leave history and artifacts unchanged. A deleted layer can be restored under its recorded identity and parent. Thumbnail writes recheck access after waiting and before publication. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}

import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function mapChildren(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "History follows its map: everyone who reaches the map reads its availability, and undo and redo are content changes. Thumbnails are the map owner's: captured by the owner and served to the owner alone, while anyone else who reaches the map reads no snapshot. Replay checks every target and parent reference before changing the whole gesture; unreached, missing or mismatched references return not_found and leave history and artifacts unchanged. A deleted layer can be restored under its recorded identity and parent. Thumbnail writes recheck access after waiting and before publication. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}

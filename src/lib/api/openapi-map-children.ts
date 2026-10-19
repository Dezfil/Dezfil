import { ERROR_RESPONSE, type op } from "./openapi-helpers";

export function mapChildren(config: Parameters<typeof op>[0]): Parameters<typeof op>[0] {
  return { ...config,
    description: "History follows its map: everyone who reaches the map reads its availability, and undo and redo are content changes. Thumbnails are rendered by the server as the map's owner and record the datasets each image drew: an image is served, and copied into a duplicate, only for someone who reaches the map and can now reach every one of them, an unattributed image for the owner alone; anyone else reads no snapshot. Replay checks every target and parent reference before changing the whole gesture; unreached, missing or mismatched references return not_found and leave history and artifacts unchanged. A deleted layer can be restored under its recorded identity and parent. Picture publication rechecks owner standing, the drawing generation and consumed inputs after waiting and before publication. " + (config.description ?? ""),
    responses: { ...config.responses, "404": ERROR_RESPONSE },
  };
}

import { metadataDb } from "./metadata/db";
import { documentFacts, type DocumentFacts } from "./metadata/document-facts";
import type { AccountScope } from "@/lib/auth/scope";
import { requirePermitted, requireReachable, type ActionOf } from "@/lib/auth/reach";
import { getLayer, type Layer } from "@/lib/metadata/maps";

/** A layer read: the layer when the acting account reaches its map, else
 * the absent refusal. */
export function requireLayer(scope: AccountScope, id: string): Layer {
  requireReachable(scope, "layer", id);
  return getLayer(id)!;
}

/** A layer write: the layer when the acting account may take this action on
 * its map, else the absent refusal (unreachable) or the permission refusal. */
export function requireLayerFor(scope: AccountScope, id: string, action: ActionOf<"layer">): Layer {
  requirePermitted(scope, "layer", id, action);
  return getLayer(id)!;
}

export function readLayer(scope: AccountScope, id: string): Layer & DocumentFacts {
  return metadataDb().transaction(() => {
    const layer = requireLayer(scope, id);
    return { ...layer, ...documentFacts({ kind: "map", id: layer.mapId }) };
  })();
}

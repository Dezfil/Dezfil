import type { AccountScope } from "@/lib/auth/scope";
import { requirePermitted, type ActionOf } from "@/lib/auth/reach";
import { getLayer, type Layer } from "@/lib/metadata/maps";
import { getOwnedLayer } from "@/lib/metadata/map-queries";

/** A layer read: its map's owner's alone. */
export function requireLayer(scope: AccountScope, id: string) {
  return getOwnedLayer(scope, id);
}

/** A layer write: the layer when the acting account may take this action on
 * its map, else the absent refusal (unreachable) or the permission refusal. */
export function requireLayerFor(scope: AccountScope, id: string, action: ActionOf<"layer">): Layer {
  requirePermitted(scope, "layer", id, action);
  return getLayer(id)!;
}

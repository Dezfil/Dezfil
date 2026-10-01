import type { AccountScope } from "@/lib/auth/scope";
import { requirePermitted, requireReachable, type ActionOf } from "@/lib/auth/reach";
import { getLayer, type Layer } from "@/lib/metadata/maps";
import { getOwnedLayer } from "@/lib/metadata/map-queries";

/** A layer read: the layer when the acting account reaches its map, else
 * the absent refusal. */
export function requireLayer(scope: AccountScope, id: string): Layer {
  requireReachable(scope, "layer", id);
  return getLayer(id)!;
}

/** The map owner's own read of a layer, for what stays the owner's: its
 * tile archive and the captures made from it. Anyone else gets the absent
 * refusal. */
export function requireOwnLayer(scope: AccountScope, id: string): Layer {
  return getOwnedLayer(scope, id);
}

/** Whether the acting account owns the map of this layer it reaches. */
export function ownsLayer(scope: AccountScope, id: string): boolean {
  return requireReachable(scope, "layer", id).relation === "owner";
}

/** A layer write: the layer when the acting account may take this action on
 * its map, else the absent refusal (unreachable) or the permission refusal. */
export function requireLayerFor(scope: AccountScope, id: string, action: ActionOf<"layer">): Layer {
  requirePermitted(scope, "layer", id, action);
  return getLayer(id)!;
}

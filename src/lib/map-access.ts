import type { AccountScope } from "@/lib/auth/scope";
import { requirePermitted, requireReachable, type ActionOf } from "@/lib/auth/reach";
import { getMap, listLayers, type MapRecord, type MapWithLayers } from "@/lib/metadata/maps";
import { getOwnedMap } from "@/lib/metadata/map-queries";
import { mapPresence, type Presence } from "@/lib/reach-presence";

/** A map read: the map when the acting account reaches it (its own, or one
 * filed in a project it owns or belongs to), else the absent refusal. */
export function requireMap(scope: AccountScope, id: string): MapRecord {
  requireReachable(scope, "map", id);
  return getMap(id)!;
}

export function mapWithLayers(scope: AccountScope, id: string): MapWithLayers {
  const map = requireMap(scope, id);
  return { ...map, layers: listLayers(id) };
}

/** A reached map as its reader sees it: its layers, the project it is filed
 * in as its reader may know it, its owner, its SQL home, and its
 * publication's token only when the reader owns the map. */
export function readMap(scope: AccountScope, id: string): MapWithLayers & Presence {
  const map = mapWithLayers(scope, id);
  return { ...map, ...mapPresence(scope, id) };
}

/**
 * The owner's own read, for what stays the owner's until it is shared
 * through a rule of its own: thumbnail files, sketch summaries,
 * duplication, server-side renders and project archives. Anyone else gets
 * the absent refusal.
 */
export function requireOwnMap(scope: AccountScope, id: string): MapRecord {
  return getOwnedMap(scope, id);
}

export function ownMapWithLayers(scope: AccountScope, id: string): MapWithLayers {
  const map = requireOwnMap(scope, id);
  return { ...map, layers: listLayers(id) };
}

/** Whether the acting account owns this map it reaches. */
export function ownsMap(scope: AccountScope, id: string): boolean {
  return requireReachable(scope, "map", id).relation === "owner";
}

/** A map write: the map when the acting account may take this action on it,
 * else the absent refusal (unreachable) or the permission refusal. */
export function requireMapFor(scope: AccountScope, id: string, action: ActionOf<"map">): MapRecord {
  requirePermitted(scope, "map", id, action);
  return getMap(id)!;
}

/** The map as a permitted write leaves it, for that write's response. */
export function mapWithLayersFor(scope: AccountScope, id: string, action: ActionOf<"map">): MapWithLayers {
  const map = requireMapFor(scope, id, action);
  return { ...map, layers: listLayers(id) };
}

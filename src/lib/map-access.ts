import type { AccountScope } from "@/lib/auth/scope";
import { canReach, requirePermitted, type ActionOf } from "@/lib/auth/reach";
import { getMap, listLayers, type MapRecord, type MapWithLayers } from "@/lib/metadata/maps";
import { getOwnedMap } from "@/lib/metadata/map-queries";
import { metadataDb } from "@/lib/metadata/db";

/** A map read: the owner's alone. */
export function requireMap(scope: AccountScope, id: string): MapRecord {
  return getOwnedMap(scope, id);
}

export function mapWithLayers(scope: AccountScope, id: string): MapWithLayers {
  const map = requireMap(scope, id);
  return { ...map, layers: listLayers(id) };
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

/** The project a map is filed in, when the acting account reaches that
 * project; null otherwise. A write's response names no project its caller
 * cannot reach. */
export function mapProjectIdFor(scope: AccountScope, id: string): string | null {
  const row = metadataDb().prepare("SELECT project_id FROM maps WHERE id = ?").get(id) as { project_id: string | null } | undefined;
  return row?.project_id && canReach(scope, "project", row.project_id) ? row.project_id : null;
}

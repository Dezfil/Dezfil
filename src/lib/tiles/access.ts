import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { metadataDb } from "@/lib/metadata/db";

const tileAccessBrand: unique symbol = Symbol("tile access");
export interface TileAccess {
  readonly [tileAccessBrand]: true;
  readonly layerId: string;
  readonly mapId: string;
  readonly ownerId: string | null;
  readonly credential: { scope: AccountScope } | { token: string };
}
function identity(layerId: string) {
  return metadataDb().prepare(`SELECT l.map_id, m.owner_id, m.publish_token, l.visible
    FROM layers l JOIN maps m ON m.id = l.map_id WHERE l.id = ?`).get(layerId) as
    { map_id: string; owner_id: string | null; publish_token: string | null; visible: number } | undefined;
}
export function privateTileAccess(scope: AccountScope, layerId: string): TileAccess {
  requireOwnedResource(scope, "layer", layerId);
  const row = identity(layerId)!;
  return Object.freeze({ [tileAccessBrand]: true as const, layerId, mapId: row.map_id, ownerId: row.owner_id, credential: Object.freeze({ scope }) });
}
/** A token grants only a visible published layer, including pending adoption
 * and an inactive publisher. It grants no private response or creation. */
export function publishedTileAccess(token: string, layerId: string): TileAccess {
  const row = identity(layerId);
  if (!row || !token || row.publish_token !== token || row.visible !== 1) throw resourceAbsent();
  return Object.freeze({ [tileAccessBrand]: true as const, layerId, mapId: row.map_id, ownerId: row.owner_id, credential: Object.freeze({ token }) });
}
export function requireTileAccess(access: TileAccess | undefined, layerId: string): void {
  if (!access || access[tileAccessBrand] !== true || access.layerId !== layerId) throw resourceAbsent();
  if ("scope" in access.credential) requireOwnedResource(access.credential.scope, "layer", layerId);
  const row = identity(layerId);
  if (!row || row.map_id !== access.mapId || row.owner_id !== access.ownerId) throw resourceAbsent();
  if ("token" in access.credential && (row.publish_token !== access.credential.token || row.visible !== 1)) throw resourceAbsent();
}
export function tileAccessAvailable(access: TileAccess): boolean {
  try { requireTileAccess(access, access.layerId); return true; } catch { return false; }
}

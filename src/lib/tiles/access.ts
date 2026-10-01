import { resolvePublication, publicationAbsent } from "@/lib/publish/publication-scope";
import type { DatasetScope } from "@/lib/query/access";
import type { AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { reachableDatasetIds, requireReachable } from "@/lib/auth/reach";
import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { mapEvaluation } from "@/lib/query/context";
import type { ArchiveAttribution } from "./evidence";
import { servableTo, servableToPublication } from "@/lib/artifact-access";

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
/** Everyone who reaches the layer's map renders it, and may prepare its tiles
 * in their own reach; which archive they are served is decided by what it
 * drew (archiveServable). */
export function privateTileAccess(scope: AccountScope, layerId: string): TileAccess {
  requireReachable(scope, "layer", layerId);
  const row = identity(layerId);
  if (!row) throw resourceAbsent();
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
  if ("scope" in access.credential) requireReachable(access.credential.scope, "layer", layerId);
  const row = identity(layerId);
  if (!row || row.map_id !== access.mapId || row.owner_id !== access.ownerId) throw resourceAbsent();
  if ("token" in access.credential && (row.publish_token !== access.credential.token || row.visible !== 1)) throw resourceAbsent();
}
/** Which reach an access asks for tiles in: a build's attempts and their
 * failures are kept apart by it, so one reach's refused or failed build
 * never stands for another's. Accounts with the same reach share one. */
export function tileReachKey(access: TileAccess): string {
  if ("token" in access.credential) return `publication:${access.mapId}`;
  const ids = [...reachableDatasetIds(access.credential.scope)].sort();
  return `reach:${createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 16)}`;
}

/** The failure of a tile request for an archive the caller may not be served. */
export function tilesUnavailable(): ApiError {
  return new ApiError("not_found", "These tiles are not available to you.", 404);
}

/** Whether this access may be served an archive so attributed: a signed-in
 * caller who can now reach every input it recorded, a publication within
 * what its map names; an unattributed archive to the map's owner alone, an
 * unbound one to nobody. */
export function archiveServable(access: TileAccess, attribution: ArchiveAttribution): boolean {
  requireTileAccess(access, access.layerId);
  if (attribution === "unbound") return false;
  const inputs = attribution === "unattributed" ? null : attribution.inputs;
  if ("scope" in access.credential) return servableTo(access.credential.scope, access.mapId, inputs);
  const publication = resolvePublication(access.credential.token);
  if (!publication || publication.scope.mapId !== access.mapId) return false;
  return servableToPublication(publication.scope, inputs);
}

export function tileAccessAvailable(access: TileAccess): boolean {
  try { requireTileAccess(access, access.layerId); return true; } catch { return false; }
}

/** Carry the admitted private account or current token into tile SQL. */
export function tileQueryScope(access: TileAccess): DatasetScope {
  requireTileAccess(access, access.layerId);
  if ("scope" in access.credential) return mapEvaluation(access.credential.scope, access.mapId);
  const publication = resolvePublication(access.credential.token);
  if (!publication || publication.scope.mapId !== access.mapId || publication.scope.ownerId !== access.ownerId) throw publicationAbsent();
  return publication.scope;
}

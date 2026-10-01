import type { AccountScope } from "@/lib/auth/scope";
import { requireReachable } from "@/lib/auth/reach";
import { getTileRecord, type TileRecord } from "@/lib/metadata/tiles";
import { archiveServable, privateTileAccess, tilesUnavailable } from "./access";
import { tileArchiveAttribution } from "./evidence";
import { readTile } from "./serve";

export function privateTileStatus(scope: AccountScope, layerId: string) {
  requireReachable(scope, "layer", layerId);
  return getTileRecord(layerId);
}

const sameArchive = (a: TileRecord | null, b: TileRecord | null) =>
  a?.state === b?.state && a?.fingerprint === b?.fingerprint && a?.builtAt === b?.builtAt;

/**
 * One tile of the layer's archive, for everyone who reaches the map and may
 * be served what the archive drew: checked before the read and again after
 * it, so an archive swapped during the read is never answered under the
 * other's authorization. Anyone else gets the tiles' named failure.
 */
export async function readPrivateTile(scope: AccountScope, layerId: string, z: number, x: number, y: number) {
  const access = privateTileAccess(scope, layerId);
  const before = getTileRecord(layerId);
  if (!archiveServable(access, tileArchiveAttribution(layerId, before))) throw tilesUnavailable();
  const tile = await readTile(layerId, z, x, y);
  const after = getTileRecord(layerId);
  if (!sameArchive(before, after) || !archiveServable(access, tileArchiveAttribution(layerId, after))) throw tilesUnavailable();
  return tile;
}

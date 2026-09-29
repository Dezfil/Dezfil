import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { getTileRecord } from "@/lib/metadata/tiles";
import { readTile } from "./serve";

export function privateTileStatus(scope: AccountScope, layerId: string) {
  requireOwnedResource(scope, "layer", layerId);
  return getTileRecord(layerId);
}
export async function readPrivateTile(scope: AccountScope, layerId: string, z: number, x: number, y: number) {
  requireOwnedResource(scope, "layer", layerId);
  const tile = await readTile(layerId, z, x, y);
  requireOwnedResource(scope, "layer", layerId);
  return tile;
}

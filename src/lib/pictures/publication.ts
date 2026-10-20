import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { ownMapWithLayers } from "@/lib/map-access";
import { metadataDb } from "@/lib/metadata/db";
import { captureBasemap } from "@/lib/thumbnail-evidence";
import { satelliteTileUrl } from "@/lib/basemap-satellite";
import { pictureMeasure } from "./measurement";
import { basemapFollowsTheme } from "@/lib/basemap-offer";
import { inputsReached } from "@/lib/artifact-access";
import { reachableDatasetIds } from "@/lib/auth/reach";
import { savePictureSet } from "@/lib/map-thumbnails";
import type { ArtifactInputs } from "@/lib/query/evaluation-inputs";
import { drawingDigest, firstFormulaDigest } from "./digest";
import { getPictureState, settlePicture } from "./state";
import { inputsAreCurrent } from "./inputs";
import type { PictureImages } from "./card";

export function pictureTarget(scope: AccountScope, mapId: string, sketchIds: readonly string[] = []) {
  const map = ownMapWithLayers(scope, mapId);
  const light = captureBasemap(mapId, "light")!;
  const dark = !map.customBasemap && basemapFollowsTheme(map.basemap) ? captureBasemap(mapId, "dark")! : undefined;
  const artifacts = sketchIds.map(id => (metadataDb().prepare("SELECT file FROM data_tables WHERE id = ?").get(id) as { file: string } | undefined)?.file ?? `missing:${id}`);
  const ground = dark ? [light.url, dark.url] : [light.url];
  // The stable imagery proxy hides provider changes. Hash the effective
  // template, but never copy its possibly secret address into evidence.
  if (!map.customBasemap && map.basemap === "satellite") {
    try { ground.push(satelliteTileUrl() ?? "unavailable"); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "service_address_unreadable") throw error;
      // The renderer uses the effective fallback while imagery is unreadable.
      // Keep that standing in the digest so restored imagery requests a picture.
      ground.push("unreadable");
    }
  }
  return { map, ownerId: scope.accountId, sketchIds: [...sketchIds], basemaps: { light, dark }, digest: drawingDigest(map, ground, artifacts),
    firstFormulaDigest: firstFormulaDigest(map, ground, artifacts) };
}
export type PictureTarget = ReturnType<typeof pictureTarget>;
export function assertPicturePublication(scope: AccountScope, target: PictureTarget, generation: number, inputs: ArtifactInputs): void {
  const fresh = pictureTarget(scope, target.map.id, target.sketchIds);
  const state = getPictureState(target.map.id);
  if (scope.accountId !== target.ownerId || fresh.digest !== target.digest || state?.digest !== target.digest || state.requestedGeneration !== generation ||
      !inputsAreCurrent(inputs) || !inputsReached(inputs, reachableDatasetIds(scope))) throw new Error("The picture's saved state or standing changed.");
}
export async function publishPicture(scope: AccountScope, target: PictureTarget, generation: number,
  images: { light: Uint8Array | PictureImages; dark?: Uint8Array | PictureImages }, inputs: ArtifactInputs): Promise<void> {
  if (!!images.dark !== !!target.basemaps.dark) throw new Error("The picture set is incomplete.");
  const check = () => assertPicturePublication(scope, target, generation, inputs);
  check();
  await savePictureSet(scope, target.map.id, images, inputs, target.basemaps, generation, check, () => {
    check();
    if (!settlePicture(target.map.id, generation, { state: "current", producer: "server", publishedGeneration: generation, publishedDigest: target.digest, attemptCount: 0 })) throw new Error("The picture request changed.");
  });
  pictureMeasure({ kind: "published", mapId: target.map.id, generation });
}

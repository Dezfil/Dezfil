import { getPictureState, type PictureStatus } from "./state";
export interface PictureListing { pictureState: PictureStatus; pictureVersion: string | null }
/** A version belongs to the published artifact, never the map's edit clock.
 * Legacy files keep their existing cache address until their first remake. */
export function pictureListing(mapId: string, served: boolean, legacyVersion: string): PictureListing {
  const state = getPictureState(mapId);
  return { pictureState: state?.state ?? "waiting", pictureVersion: !served ? null :
    !state || state.producer === "old" ? `old-${legacyVersion}` : `${state.producer}-${state.publishedGeneration}` };
}

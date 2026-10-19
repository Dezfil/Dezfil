import { publishedPictureGeneration } from "@/lib/map-thumbnails";
import { getPictureState, requestPicture } from "./state";

/** An interrupted publication can leave files ahead of their row. Preserve
 * a pending generation and retry it once; a previously current row whose
 * files disappeared requests a new generation. Inheritance keeps its source
 * evidence until the first drawing change. */
export async function reconcilePictureFiles(mapId: string, hasPicture: boolean, now: number) {
  const generation = await publishedPictureGeneration(mapId);
  const state = getPictureState(mapId);
  if (!state) return null;
  const agrees = hasPicture && (state.producer !== "server" || generation === state.publishedGeneration);
  if (!agrees && state.state === "current") return requestPicture(mapId, state.digest, now, true);
  return state;
}

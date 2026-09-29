import type { Layer } from "@/lib/metadata/maps";
import type { HistoryImage } from "@/lib/metadata/history";

/** The full layer as one image — what an add or delete step records;
 * shared with the removal cascade. */
export function layerImage(layer: Layer): HistoryImage {
  return { ...layer };
}

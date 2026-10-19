import { createMap } from "@/lib/map-service";
import { metadataDb } from "@/lib/metadata/db";
import type { AccountScope } from "@/lib/auth/scope";
import { saveThumbnail } from "@/lib/map-thumbnails";
import { pictureTarget, publishPicture } from "@/lib/pictures/publication";
import { requestPicture } from "@/lib/pictures/state";
import { NO_INPUTS } from "@/lib/query/evaluation-inputs";
import { encodePng } from "@/lib/export/png-codec";

export type CapacityKind = "first" | "missing" | "mixed";
export interface CapacityMap { id: string; group: "missing" | "old" | "current"; pair: boolean; }
/** Offline fixture only: no picture service is started while the store is seeded. */
export async function seedPictureCapacity(scope: AccountScope, kind: CapacityKind): Promise<CapacityMap[]> {
  const maps: CapacityMap[] = [], now = Date.now() - 60000;
  const png = encodePng({ width: 1, height: 1, rgba: new Uint8Array([28, 79, 64, 255]) });
  for (let i = 0; i < (kind === "first" ? 20 : 300); i++) {
    const group = kind !== "mixed" || i < 100 ? "missing" : i < 200 ? "old" : "current";
    const pair = i % 2 === 1;
    const map = createMap(scope, `Capacity ${group} ${i}`);
    // Old pictures are newer than missing ones: only the work priority, not
    // the edit clock, can put the missing cohort first.
    metadataDb().prepare("UPDATE maps SET basemap = ?, updated_at = ? WHERE id = ?")
      .run(pair ? null : "light", new Date(now + i).toISOString(), map.id);
    if (group === "old") await saveThumbnail(scope, map.id, png);
    if (group === "current") {
      const target = pictureTarget(scope, map.id), state = requestPicture(map.id, target.digest, now);
      await publishPicture(scope, target, state.requestedGeneration, { light: png, ...(pair ? { dark: png } : {}) }, NO_INPUTS);
    }
    maps.push({ id: map.id, group, pair });
  }
  return maps;
}

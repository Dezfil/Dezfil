import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { getPictureState, requestPicture, settlePicture, type PictureState } from "./state";

/** Files cannot be inspected by a schema migration. The first look adopts
 * their existence once, using the only historical drawing clock available. */
export function initializePicture(mapId: string, digest: string, hasPicture: boolean, editedAt: number, db: Database = metadataDb()): PictureState {
  return db.transaction(() => {
    const previous = getPictureState(mapId, db);
    if (previous) return previous;
    const state = requestPicture(mapId, digest, editedAt, false, db);
    if (hasPicture) settlePicture(mapId, state.requestedGeneration, { producer: "old" }, db);
    return getPictureState(mapId, db)!;
  })();
}

/** Called only after a whole permitted inheritance has finished. */
export function adoptPicture(mapId: string, digest: string, now: number, db: Database = metadataDb()): PictureState {
  return db.transaction(() => {
    const state = requestPicture(mapId, digest, now, false, db);
    settlePicture(mapId, state.requestedGeneration, { state: "current", producer: "inherited", publishedDigest: digest, publishedGeneration: state.requestedGeneration, attemptCount: 0 }, db);
    return getPictureState(mapId, db)!;
  })();
}

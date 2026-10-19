import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { requestDrawing, type DrawingFreshness } from "./digest";
export type PictureStatus = "current" | "waiting" | "failed" | "unsupported" | "unavailable";
export type PictureProducer = "server" | "inherited" | "old";
export interface PictureState extends DrawingFreshness {
  mapId: string;
  state: PictureStatus;
  publishedDigest: string | null;
  producer: PictureProducer;
  attemptCount: number;
  nextAttemptAt: number;
  requestedAt: number;
}
const columns = `map_id AS mapId, state, digest, published_digest AS publishedDigest,
  requested_generation AS requestedGeneration, published_generation AS publishedGeneration,
  drawing_changed_at AS drawingChangedAt, producer, attempt_count AS attemptCount,
  next_attempt_at AS nextAttemptAt, requested_at AS requestedAt`;
export function getPictureState(mapId: string, db: Database = metadataDb()): PictureState | null {
  return db.prepare(`SELECT ${columns} FROM map_pictures WHERE map_id = ?`).get(mapId) as PictureState | undefined ?? null;
}
export function listPictureStates(db: Database = metadataDb()): PictureState[] {
  return db.prepare(`SELECT ${columns} FROM map_pictures ORDER BY CASE WHEN producer = 'old' AND requested_generation = 1 THEN 1 ELSE 0 END, drawing_changed_at DESC, map_id`).all() as PictureState[];
}
export function requestPicture(mapId: string, digest: string, now: number, force = false, db: Database = metadataDb()): PictureState {
  return db.transaction(() => {
    const previous = getPictureState(mapId, db);
    const next = requestDrawing(previous, digest, now, force);
    if (previous && next === previous) return previous;
    if (!previous) db.prepare(`INSERT INTO map_pictures (map_id, digest, requested_generation, drawing_changed_at, requested_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(mapId, digest, next.requestedGeneration, next.drawingChangedAt, now, now + 5000);
    else db.prepare(`UPDATE map_pictures SET digest = ?, requested_generation = ?, drawing_changed_at = ?, requested_at = ?, next_attempt_at = ?, state = 'waiting', attempt_count = 0 WHERE map_id = ?`)
      .run(digest, next.requestedGeneration, next.drawingChangedAt, now, now + 5000, mapId);
    return getPictureState(mapId, db)!;
  })();
}
const writable = { state: "state", publishedGeneration: "published_generation", publishedDigest: "published_digest", producer: "producer", attemptCount: "attempt_count", nextAttemptAt: "next_attempt_at" } as const;
/** Compare-and-set never resurrects deleted work or settles a newer request. */
export function settlePicture(mapId: string, generation: number, fields: Partial<Pick<PictureState, keyof typeof writable>>, db: Database = metadataDb()): boolean {
  const entries = Object.entries(fields) as [keyof typeof writable, string | number | null][];
  if (!entries.length) return false;
  return db.prepare(`UPDATE map_pictures SET ${entries.map(([key]) => `${writable[key]} = ?`).join(", ")} WHERE map_id = ? AND requested_generation = ?`)
    .run(...entries.map(([, value]) => value), mapId, generation).changes === 1;
}

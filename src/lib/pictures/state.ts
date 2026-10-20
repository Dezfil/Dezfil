import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import { onCurrentFormula, requestDrawing, type DrawingFreshness } from "./digest";
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
/** Work in queue order: the most recent drawing change first, and after
 * all of it the old road's first pictures and the re-makes. */
export function listPictureStates(db: Database = metadataDb()): PictureState[] {
  return db.prepare(`SELECT ${columns} FROM map_pictures ORDER BY CASE WHEN (producer = 'old' AND requested_generation = 1) OR requested_generation = remake_generation THEN 1 ELSE 0 END, drawing_changed_at DESC, map_id`).all() as PictureState[];
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
/**
 * A row still on the digest's first formula moves to the current one
 * without touching its times or attempts: its requested digest when that is
 * the first formula's digest of the map now, its published digest when that
 * was the requested one. A row that no longer matches is left as it is, so
 * the request that follows sees the real change it is.
 */
export function moveDigestFormula(mapId: string, target: { digest: string; firstFormulaDigest: string }, db: Database = metadataDb()): PictureState | null {
  return db.transaction(() => {
    const row = getPictureState(mapId, db);
    if (!row || onCurrentFormula(row.digest) || row.digest !== target.firstFormulaDigest) return row;
    db.prepare("UPDATE map_pictures SET digest = ?, published_digest = CASE WHEN published_digest = digest THEN ? ELSE published_digest END WHERE map_id = ?")
      .run(target.digest, target.digest, mapId);
    return getPictureState(mapId, db);
  })();
}
/**
 * A current picture made before pictures kept their sizes is made once
 * more, at a new generation remembered as a re-make, keeping its
 * drawing-change time. Rows waiting, failed or unsupported keep their
 * attempts and waits; a real change later moves the row into the ordinary
 * order.
 */
export function requestRemake(mapId: string, now: number, db: Database = metadataDb()): PictureState | null {
  db.prepare(`UPDATE map_pictures SET requested_generation = requested_generation + 1, remake_generation = requested_generation + 1,
    state = 'waiting', attempt_count = 0, requested_at = ?, next_attempt_at = ? WHERE map_id = ? AND state = 'current'`).run(now, now, mapId);
  return getPictureState(mapId, db);
}
const writable = { state: "state", publishedGeneration: "published_generation", publishedDigest: "published_digest", producer: "producer", attemptCount: "attempt_count", nextAttemptAt: "next_attempt_at" } as const;
/** Compare-and-set never resurrects deleted work or settles a newer request. */
export function settlePicture(mapId: string, generation: number, fields: Partial<Pick<PictureState, keyof typeof writable>>, db: Database = metadataDb()): boolean {
  const entries = Object.entries(fields) as [keyof typeof writable, string | number | null][];
  if (!entries.length) return false;
  return db.prepare(`UPDATE map_pictures SET ${entries.map(([key]) => `${writable[key]} = ?`).join(", ")} WHERE map_id = ? AND requested_generation = ?`)
    .run(...entries.map(([, value]) => value), mapId, generation).changes === 1;
}

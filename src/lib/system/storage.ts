import type { Database } from "better-sqlite3";
import { statfs } from "node:fs/promises";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { dataDir } from "@/lib/config";
import { metadataDb } from "@/lib/metadata/db";
import { STORAGE_KINDS, type StorageKind, type StorageRead, type StorageUse } from "./storage-answer";
import { readStorageReferences } from "./storage-references";
import { beforeDeadline, emptyTally, TOO_LATE, walkDataFolder } from "./storage-walk";

/**
 * The storage read: what the data folder holds, by kind, from one walk of
 * it (`storage-walk.ts`) after the metadata's references are read
 * (`storage-references.ts`), with the disk's statistics, all inside one
 * 10-second budget: the reference read is cut between its slices, every
 * filesystem call is raced against the deadline, and past it the answer
 * gives what was not finished as at least. One walk at a time: a read
 * while one runs gets that walk's answer, and a read within 30 seconds of
 * the last walk gets that answer again, unless a cache was cleared since.
 * The admin is rechecked on every read, joined or not.
 */

/** The walk's budget, the reference read included. */
export const STORAGE_WALK_MS = 10_000;
/** How long a finished walk's answer is given again. */
export const STORAGE_REUSE_MS = 30_000;

interface Kept {
  walking: Promise<StorageRead> | null;
  last: { answer: StorageRead; at: number; generation: number } | null;
  /** Moves on at each forgetting; a walk begun before it is not kept. */
  generation: number;
}
const key = Symbol.for("dezfil.storage-read");
const host = globalThis as typeof globalThis & { [key]?: Kept };
const kept = host[key] ??= { walking: null, last: null, generation: 0 };

/** The volume's free and total bytes, or null when the system would not
 * say by the deadline. */
async function disk(folder: string, deadline: number): Promise<StorageRead["disk"]> {
  try {
    const volume = await beforeDeadline(statfs(folder), deadline);
    if (volume === TOO_LATE) return null;
    return { free: volume.bavail * volume.bsize, total: volume.blocks * volume.bsize };
  } catch {
    return null;
  }
}

async function walk(db: Database): Promise<StorageRead> {
  const deadline = Date.now() + STORAGE_WALK_MS;
  const folder = dataDir();
  // Asked first, answered beside the walk, held to the same deadline.
  const space = disk(folder, deadline);
  const references = readStorageReferences(db, deadline);
  // Without the references in time, no file can be told; nothing is finished.
  const kinds = !references || Date.now() >= deadline ? emptyTally(false) : await walkDataFolder(folder, references, deadline);
  const all = STORAGE_KINDS.map(kind => kinds[kind]);
  const total: StorageUse = {
    bytes: all.reduce((sum, use) => sum + use.bytes, 0),
    files: all.reduce((sum, use) => sum + use.files, 0),
    finished: all.every(use => use.finished),
  };
  return { kinds: Object.fromEntries(STORAGE_KINDS.map(kind => [kind, { ...kinds[kind] }])) as Record<StorageKind, StorageUse>, total, disk: await space };
}

/** Read what the data folder holds, the admin rechecked first. */
export async function readStorage(context: AuthContext, db: Database = metadataDb(), now = Date.now()): Promise<StorageRead> {
  requireAdmin(context, db, now);
  if (kept.walking) return kept.walking;
  const last = kept.last;
  if (last && last.generation === kept.generation && Date.now() - last.at < STORAGE_REUSE_MS) return last.answer;
  const generation = kept.generation;
  const walking: Promise<StorageRead> = walk(db).then(answer => {
    if (kept.generation === generation) kept.last = { answer, at: Date.now(), generation };
    return answer;
  }).finally(() => {
    if (kept.walking === walking) kept.walking = null;
  });
  kept.walking = walking;
  return walking;
}

/** Forget the last answer: the next read walks afresh. A cache's Clear
 * calls this once the answers are gone. */
export function forgetStorageRead(): void {
  kept.generation += 1;
  kept.last = null;
}

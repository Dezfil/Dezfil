import { roundedStorageState } from "./storage-state";
import type { Database } from "better-sqlite3";
import { statfs } from "node:fs/promises";
import { requireAdmin } from "@/lib/auth/admin";
import type { AuthContext } from "@/lib/auth/credentials";
import { dataDir } from "@/lib/config";
import { metadataDb } from "@/lib/metadata/db";
import { templateArtifactsInUse } from "@/lib/templates/artifacts";
import { STORAGE_KINDS, type StorageKind, type StorageRead, type StorageUse } from "./storage-answer";
import type { StorageReferences } from "./storage-places";
import { readStorageReferences } from "./storage-references";
import { beforeDeadline, emptyTally, TOO_LATE, walkDataFolder } from "./storage-walk";

/**
 * The storage read: what the data folder holds, by kind, from one walk of
 * it (`storage-walk.ts`) after the metadata's references are read
 * (`storage-references.ts`), the installed templates' records read beside
 * its first folder, with the disk's statistics. Every read has one
 * deadline, 10 seconds from when it was asked: every filesystem call of the
 * walk that answers it, the disk's statistics and the templates' records
 * among them, is raced against the deadline, and the reference read is
 * checked against it between its
 * slices, so a slice under way when it passes runs to its end; past it the
 * answer gives what was not finished as at least. One walk at a time: a read
 * while one runs gets that walk's answer, and a read within 30 seconds of
 * the last walk gets that answer again, unless a cache was cleared since.
 * A Clear ends the walk under way at once, its readers getting what it had
 * counted, the rest as at least; a read after the Clear never gets a walk
 * begun before it, but waits for that walk to settle, which it does at
 * once, and joins one fresh walk, begun with the deadline of the first
 * read back. The admin is rechecked on every read, joined or not.
 */

/** A read's budget, from when it is asked, the reference read included. */
export const STORAGE_WALK_MS = 10_000;
/** How long a finished walk's answer is given again. */
export const STORAGE_REUSE_MS = 30_000;

type WalkRead = Omit<StorageRead, "state">;
const withState = (answer: WalkRead): StorageRead => ({ ...answer, state: roundedStorageState() });

interface Kept {
  /** The walk under way, with the generation it began under and what ends it early. */
  walking: { answer: Promise<WalkRead>; generation: number; stop: AbortController } | null;
  last: { answer: WalkRead; at: number; generation: number } | null;
  /** Moves on at each forgetting; a walk begun before it is not kept. */
  generation: number;
}
const key = Symbol.for("dezfil.storage-read");
const host = globalThis as typeof globalThis & { [key]?: Kept };
const kept = host[key] ??= { walking: null, last: null, generation: 0 };

/** The volume's free and total bytes, or null when the system would not
 * say by the deadline, or before the walk was ended. */
async function disk(folder: string, deadline: number, stop: AbortSignal): Promise<StorageRead["disk"]> {
  try {
    const volume = await beforeDeadline(statfs(folder), deadline, stop);
    if (volume === TOO_LATE) return null;
    return { free: volume.bavail * volume.bsize, total: volume.blocks * volume.bsize };
  } catch {
    return null;
  }
}

/** The engine's copies the installed templates need, or null when their
 * records were not read by the deadline, or before the walk was ended. */
async function templateReferences(deadline: number, stop: AbortSignal): Promise<ReadonlySet<string> | null> {
  if (Date.now() >= deadline || stop.aborted) return null;
  try {
    const files = await beforeDeadline(templateArtifactsInUse(), deadline, stop);
    return files === TOO_LATE ? null : files;
  } catch {
    return null;
  }
}

async function walk(db: Database, deadline: number, stop: AbortSignal): Promise<WalkRead> {
  const folder = dataDir();
  // Asked first, answered beside the walk, held to the same deadline.
  const space = disk(folder, deadline, stop);
  const templateFiles = templateReferences(deadline, stop);
  const metadata = readStorageReferences(db, deadline);
  // Without the references in time, no file can be told; nothing is finished.
  const kinds = !metadata || Date.now() >= deadline || stop.aborted
    ? emptyTally(false)
    : await walkDataFolder(folder, templateFiles.then((files): StorageReferences | null => files && { ...metadata, templateFiles: files }), deadline, stop);
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
  const deadline = Date.now() + STORAGE_WALK_MS;
  for (;;) {
    const current = kept.walking;
    if (current?.generation === kept.generation) return withState(await current.answer);
    if (current) {
      // Begun before a Clear, which has ended it: its answer is not this
      // read's. Once it has settled, the first read back starts the one
      // fresh walk the others join, held to that read's own deadline.
      await current.answer.catch(() => {});
      continue;
    }
    const last = kept.last;
    if (last && last.generation === kept.generation && Date.now() - last.at < STORAGE_REUSE_MS) return withState(last.answer);
    const generation = kept.generation;
    const stop = new AbortController();
    const walking = {
      generation,
      stop,
      answer: walk(db, deadline, stop.signal).then(answer => {
        if (kept.generation === generation) kept.last = { answer, at: Date.now(), generation };
        return answer;
      }).finally(() => {
        if (kept.walking === walking) kept.walking = null;
      }),
    };
    kept.walking = walking;
    return withState(await walking.answer);
  }
}

/** Forget the last answer and end the walk under way: the next read walks
 * afresh. A cache's Clear calls this once the answers are gone. */
export function forgetStorageRead(): void {
  kept.generation += 1;
  kept.last = null;
  kept.walking?.stop.abort();
}

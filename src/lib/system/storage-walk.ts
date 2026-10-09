import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { STORAGE_KINDS, type StorageKind, type StorageUse } from "./storage-answer";
import { kindsWithin, placeOf, type StorageReferences } from "./storage-places";

/**
 * One walk of the data folder: its entries, folder by folder from an
 * explicit list rather than by recursion, each looked at with `lstat` for
 * its kind and size. No file is opened and no link is followed: a link,
 * to a file or to a folder, counts nothing. The deadline is checked before
 * every entry, and every filesystem call is raced against it, so a call
 * that does not come back cannot hold the walk past it; a walk stopped by
 * it marks every kind the folders it had not finished may hold as
 * unfinished, so what it counted of those is a floor, never a misreading.
 *
 * The ownership records are walked last, once every staged export has
 * been seen: the record of each, named by its path as the ownership road
 * names it, goes with it at the restart and counts as a leftover.
 */

/** The folder of ownership records, and the staged exports whose records go with them. */
const RECORDS = "file-owners";
const STAGED = "exports";

/** The name of the ownership record of the file at `segments`, as the
 * ownership road names it: the digest of its path under the data folder. */
const recordName = (segments: readonly string[]) => `${createHash("sha256").update(segments.join(path.sep)).digest("hex")}.json`;

/** What a call raced against the deadline gives when the deadline comes first. */
export const TOO_LATE = Symbol("too late");

/** `work`'s outcome, or `TOO_LATE` once the deadline passes first. Work left
 * pending stays owned: its outcome, whenever it comes, is observed and
 * dropped, and the caller starts nothing after it. */
export function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof TOO_LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TOO_LATE>(resolve => { timer = setTimeout(() => resolve(TOO_LATE), Math.max(deadline - Date.now(), 0)); });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type Tally = Record<StorageKind, { bytes: number; files: number; finished: boolean }>;

export function emptyTally(finished = true): Tally {
  return Object.fromEntries(STORAGE_KINDS.map(kind => [kind, { bytes: 0, files: 0, finished }])) as Tally;
}

const gone = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");

export async function walkDataFolder(root: string, references: StorageReferences, deadline: number): Promise<Readonly<Record<StorageKind, StorageUse>>> {
  const tally = emptyTally();
  const unfinished = (dir: readonly string[]) => { for (const kind of kindsWithin(dir, references)) tally[kind].finished = false; };
  const stop = (current: readonly string[], waiting: readonly (readonly string[])[]) => {
    unfinished(current);
    for (const dir of waiting) unfinished(dir);
    return tally;
  };
  // Every entry under the staged exports, by its record's name.
  const leaving = new Set<string>();
  const folders: string[][] = [[]];
  while (folders.length > 0) {
    const dir = folders.pop()!;
    if (Date.now() >= deadline) return stop(dir, folders);
    let names: string[] | typeof TOO_LATE;
    try {
      names = await beforeDeadline(readdir(path.join(root, ...dir)), deadline);
    } catch (error) {
      // A folder removed while the walk ran holds nothing; one it cannot read is not finished.
      if (!gone(error)) unfinished(dir);
      continue;
    }
    if (names === TOO_LATE) return stop(dir, folders);
    for (const name of names) {
      if (Date.now() >= deadline) return stop(dir, folders);
      const segments = [...dir, name];
      let entry;
      try { entry = await beforeDeadline(lstat(path.join(root, ...segments)), deadline); } catch { continue; } // removed meanwhile
      if (entry === TOO_LATE) return stop(dir, folders);
      if (segments[0] === STAGED && segments.length > 1) leaving.add(recordName(segments));
      if (entry.isDirectory()) {
        // The records' folder waits beneath every other, so it is walked last.
        if (segments.length === 1 && name === RECORDS) folders.unshift(segments);
        else folders.push(segments);
        continue;
      }
      if (!entry.isFile()) continue; // a link, a socket: nothing
      const kind = tally[placeOf(segments, references, leaving)];
      kind.bytes += entry.size;
      kind.files += 1;
    }
  }
  return tally;
}

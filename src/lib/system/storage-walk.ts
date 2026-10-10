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
 * it, or ended early by its `stop`, marks every kind the folders it had not
 * finished may hold as unfinished, so what it counted of those is a floor,
 * never a misreading.
 */

/** What a call raced against the deadline gives when the deadline comes first. */
export const TOO_LATE = Symbol("too late");

/** `work`'s outcome, or `TOO_LATE` once the deadline passes, or `stop`
 * aborts, first. Work left pending stays owned: its outcome, whenever it
 * comes, is observed and dropped, and the caller starts nothing after it. */
export function beforeDeadline<T>(work: Promise<T>, deadline: number, stop?: AbortSignal): Promise<T | typeof TOO_LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStop: (() => void) | undefined;
  const late = new Promise<typeof TOO_LATE>(resolve => {
    timer = setTimeout(() => resolve(TOO_LATE), Math.max(deadline - Date.now(), 0));
    onStop = () => resolve(TOO_LATE);
    if (stop?.aborted) onStop();
    else stop?.addEventListener("abort", onStop, { once: true });
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
    if (onStop) stop?.removeEventListener("abort", onStop);
  });
}

type Tally = Record<StorageKind, { bytes: number; files: number; finished: boolean }>;

export function emptyTally(finished = true): Tally {
  return Object.fromEntries(STORAGE_KINDS.map(kind => [kind, { bytes: 0, files: 0, finished }])) as Tally;
}

const gone = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");

export async function walkDataFolder(root: string, references: StorageReferences, deadline: number, stop?: AbortSignal): Promise<Readonly<Record<StorageKind, StorageUse>>> {
  const tally = emptyTally();
  const over = () => Date.now() >= deadline || stop?.aborted === true;
  const unfinished = (dir: readonly string[]) => { for (const kind of kindsWithin(dir, references)) tally[kind].finished = false; };
  const cut = (current: readonly string[], waiting: readonly (readonly string[])[]) => {
    unfinished(current);
    for (const dir of waiting) unfinished(dir);
    return tally;
  };
  const folders: string[][] = [[]];
  while (folders.length > 0) {
    const dir = folders.pop()!;
    if (over()) return cut(dir, folders);
    let names: string[] | typeof TOO_LATE;
    try {
      names = await beforeDeadline(readdir(path.join(root, ...dir)), deadline, stop);
    } catch (error) {
      // A folder removed while the walk ran holds nothing; one it cannot read is not finished.
      if (!gone(error)) unfinished(dir);
      continue;
    }
    if (names === TOO_LATE) return cut(dir, folders);
    for (const name of names) {
      if (over()) return cut(dir, folders);
      const segments = [...dir, name];
      let entry;
      try { entry = await beforeDeadline(lstat(path.join(root, ...segments)), deadline, stop); } catch { continue; } // removed meanwhile
      if (entry === TOO_LATE) return cut(dir, folders);
      if (entry.isDirectory()) {
        folders.push(segments);
        continue;
      }
      if (!entry.isFile()) continue; // a link, a socket: nothing
      const kind = tally[placeOf(segments, references)];
      kind.bytes += entry.size;
      kind.files += 1;
    }
  }
  return tally;
}

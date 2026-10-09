import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { STORAGE_KINDS, type StorageKind, type StorageUse } from "./storage-answer";
import { kindsWithin, placeOf, type StorageReferences } from "./storage-places";

/**
 * One walk of the data folder: its entries, folder by folder from an
 * explicit list rather than by recursion, each looked at with `lstat` for
 * its kind and size. No file is opened and no link is followed: a link,
 * to a file or to a folder, counts nothing. The deadline is checked before
 * every entry; a walk stopped by it marks every kind the folders it had
 * not finished may hold as unfinished, so what it counted of those is a
 * floor, never a misreading.
 */

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
  const folders: string[][] = [[]];
  while (folders.length > 0) {
    const dir = folders.pop()!;
    if (Date.now() >= deadline) return stop(dir, folders);
    let names: string[];
    try {
      names = await readdir(path.join(root, ...dir));
    } catch (error) {
      // A folder removed while the walk ran holds nothing; one it cannot read is not finished.
      if (!gone(error)) unfinished(dir);
      continue;
    }
    for (const name of names) {
      if (Date.now() >= deadline) return stop(dir, folders);
      const segments = [...dir, name];
      let entry;
      try { entry = await lstat(path.join(root, ...segments)); } catch { continue; } // removed meanwhile
      if (entry.isDirectory()) { folders.push(segments); continue; }
      if (!entry.isFile()) continue; // a link, a socket: nothing
      const kind = tally[placeOf(segments, references)];
      kind.bytes += entry.size;
      kind.files += 1;
    }
  }
  return tally;
}

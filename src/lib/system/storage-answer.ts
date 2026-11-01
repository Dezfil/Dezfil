/**
 * What the storage read answers, in a closed shape: for each kind of file
 * in the data folder the bytes its files take and how many there are, and
 * whether the walk finished that kind (else what it counted is at least
 * that); the same for everything together; and the free and total space
 * on the folder's volume. It holds no name, owner, account, map, dataset,
 * path or file name: there is no place in it for one. No server import
 * here: the System tab reads this module too.
 */

export const STORAGE_MB = 1024 * 1024;
/** The instance counts as full at this much free space or less. It is fixed. */
export const STORAGE_FULL_BYTES = 512 * STORAGE_MB;

/** The kinds, in the order Storage lists them. */
export const STORAGE_KINDS = ["tables", "tile_archives", "service_caches", "thumbnails", "profile_pictures", "templates", "metadata_database", "leftover_files", "other"] as const;
export type StorageKind = typeof STORAGE_KINDS[number];

export interface StorageUse {
  readonly bytes: number;
  readonly files: number;
  /** False when the walk stopped at its limit before it had seen every
   * file of this kind: the bytes and files are then at least these. */
  readonly finished: boolean;
}

export interface StorageRead {
  readonly state: StorageState;
  readonly kinds: Readonly<Record<StorageKind, StorageUse>>;
  /** What the data folder holds: every kind together. */
  readonly total: StorageUse;
  /** Free and total bytes on the data folder's volume, or null when the
   * system would not say. */
  readonly disk: { readonly free: number; readonly total: number } | null;
}

/** The uncached volume state. Public capacities are whole MB, in bytes. */
export interface StorageState {
  readonly full: boolean;
  readonly free: number;
  readonly total: number;
  readonly threshold: number;
}

/** The line a screen shows while full: free space in whole MB, as a refusal says it. */
export function storageFullLine(state: Pick<StorageState, "free">): string {
  return `Storage is full: ${Math.round(state.free / STORAGE_MB)} MB free.`;
}

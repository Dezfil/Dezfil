import { STORAGE_KINDS, storageFullLine, type StorageKind, type StorageRead, type StorageState, type StorageUse } from "@/lib/system/storage-answer";
import { sizeWords } from "./data-table";

/**
 * System's Storage rows: each kind of file the data folder holds, at its
 * address with its label and search words, then Free on the disk; and the
 * words each row says, from the storage read alone. A kind the read did not
 * finish is at least what it counted. The read names no file, path or
 * person, so nothing here can draw one.
 */

export interface StorageRowFacts {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
  /** The quiet line under the label. */
  readonly meta?: string;
}

export const STORAGE_CARD = { id: "system-storage", title: "Storage", keys: "disk storage space usage size" } as const;

export const LEFTOVER_NOTE = "Includes work in progress. What is left goes at the next restart.";

/** Templates holds more than the Templates card's Downloaded row: the
 * query engine reads an installed template's data from copies kept beside
 * the tables, the shipped templates' among them. */
export const TEMPLATES_NOTE = "Counts the downloads and the query engine’s copies of installed templates’ data.";

const DISK = "disk storage space size";
export const STORAGE_ROWS: Readonly<Record<StorageKind, StorageRowFacts>> = {
  tables: { id: "sys-tables", label: "Tables", keys: `${DISK} tables datasets geoparquet` },
  tile_archives: { id: "sys-tiles", label: "Tile archives", keys: `${DISK} tiles pmtiles archives` },
  service_caches: { id: "sys-caches", label: "Service caches", keys: `${DISK} cache caches geocode overpass isochrone clear` },
  thumbnails: { id: "sys-thumbnails", label: "Thumbnails", keys: `${DISK} thumbnails images cards` },
  profile_pictures: { id: "sys-pictures", label: "Profile pictures", keys: `${DISK} profile pictures people faces photos avatars` },
  templates: { id: "sys-templates", label: "Templates", keys: `${DISK} templates downloaded downloads examples`, meta: TEMPLATES_NOTE },
  metadata_database: { id: "sys-metadata-size", label: "Metadata database", keys: `${DISK} sqlite metadata` },
  leftover_files: { id: "sys-leftovers", label: "Leftover files", keys: `${DISK} leftover stray orphan scratch temporary sweep restart`, meta: LEFTOVER_NOTE },
  other: { id: "sys-other", label: "Other", keys: `${DISK} other rest records` },
};

export const FREE_ROW: StorageRowFacts = { id: "sys-free", label: "Free on the disk", keys: "disk free space volume" };

const grouped = (count: number) => new Intl.NumberFormat("en-US").format(count);
const atLeast = (use: StorageUse, words: string) => use.finished ? words : `At least ${words}`;

/** A kind's size, None for nothing; at least it when the read did not
 * finish the kind, and Not counted when it counted none of it. */
export function amountWords(use: StorageUse): string {
  if (use.bytes === 0 && use.files === 0) return use.finished ? "None" : "Not counted";
  return atLeast(use, use.bytes === 0 ? "0 KB" : sizeWords(use.bytes));
}

/** How many files a kind holds, nothing for none. */
export function filesWords(use: StorageUse): string {
  if (use.files === 0) return "";
  return atLeast(use, `${grouped(use.files)} ${use.files === 1 ? "file" : "files"}`);
}

/** A kind's share of what the data folder holds, in whole percent. */
export function shareOf(use: StorageUse, total: StorageUse): number {
  if (total.bytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * use.bytes / total.bytes)));
}

/** The free space of the total on the folder's volume, or Unknown. */
export function freeWords(disk: Pick<StorageState, "free" | "total"> | null): string {
  return disk ? `${sizeWords(disk.free)} of ${sizeWords(disk.total)}` : "Unknown";
}

/** What the card says while full: the state, and the threshold it is held against. */
export function storageFullWords(state: StorageState): string {
  return `${storageFullLine(state)} Storage counts as full at ${sizeWords(state.threshold)} free or less.`;
}

/** The read once Clear all has emptied the caches: the total is what the
 * other kinds hold; the disk is as it was read. */
export function cachesCleared(read: StorageRead): StorageRead {
  const kinds = { ...read.kinds, service_caches: { bytes: 0, files: 0, finished: true } };
  const uses = STORAGE_KINDS.map(kind => kinds[kind]);
  return {
    kinds,
    total: { bytes: uses.reduce((sum, use) => sum + use.bytes, 0), files: uses.reduce((sum, use) => sum + use.files, 0), finished: uses.every(use => use.finished) },
    disk: read.disk,
    state: read.state,
  };
}

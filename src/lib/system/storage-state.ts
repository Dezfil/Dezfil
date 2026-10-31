import type { StorageState } from "./storage-answer";
export type { StorageState } from "./storage-answer";
import path from "node:path";
import { statfsSync } from "node:fs";
import { dataDir } from "@/lib/config";

export const STORAGE_MB = 1024 * 1024;
export const STORAGE_FULL_BYTES = 512 * STORAGE_MB;
export type StorageReading = (folder: string) => { free: number; total: number };

function volumeReading(folder: string): { free: number; total: number } {
  for (let at = folder; ; at = path.dirname(at)) {
    try {
      const volume = statfsSync(at);
      return { free: volume.bavail * volume.bsize, total: volume.blocks * volume.bsize };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(at) === at) throw error;
    }
  }
}

/** Only the transition bit is retained, never names or account content. */
const key = Symbol.for("dezfil.storage-state");
const host = globalThis as typeof globalThis & { [key]?: { full: boolean } };
const transition = host[key] ??= { full: false };

/** Admission reads the volume afresh; the larger storage walk may be cached.
 * The reading and transition holder are injectable without changing settings. */
export function readStorageState(
  read: StorageReading = volumeReading,
  previous = transition,
  log: (message: string) => void = console.info,
): StorageState {
  const folder = dataDir();
  const { free, total } = read(folder);
  const full = free <= STORAGE_FULL_BYTES;
  if (full !== previous.full) {
    previous.full = full;
    log(`[storage] ${full ? "full" : "available"}: ${folder}; ${free} bytes free`);
  }
  return { full, free, total, threshold: STORAGE_FULL_BYTES };
}

/** Public reads disclose whole MB, while admission always compares bytes. */
export function roundedStorageState(state = readStorageState()): StorageState {
  return { ...state, free: Math.round(state.free / STORAGE_MB) * STORAGE_MB,
    total: Math.round(state.total / STORAGE_MB) * STORAGE_MB };
}

export function storageMessage(state = readStorageState()): string {
  return `This instance's storage is full: ${Math.round(state.free / STORAGE_MB)} MB free of ${Math.round(state.total / STORAGE_MB)} MB. Delete datasets or maps you no longer need, or ask an admin to free space.`;
}

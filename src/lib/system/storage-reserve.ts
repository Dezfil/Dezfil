import { closeSync, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { fenceStorageWriters } from "./storage-fence";
import { isStorageExhausted, storageExhausted } from "./storage-errors";
import { readStorageState, STORAGE_MB, type StorageState } from "./storage-state";

export const STORAGE_RESERVE_NAME = ".storage-reserve";
export const STORAGE_RESERVE_BYTES = 64 * STORAGE_MB;
export const STORAGE_RELEASE_BYTES = 8 * STORAGE_MB;
const key = Symbol.for("dezfil.storage-recovery");
const host = globalThis as typeof globalThis & { [key]?: {
  tail: Promise<void>; timer?: ReturnType<typeof setInterval>;
} };
const state = host[key] ??= { tail: Promise.resolve() };
const reservePath = () => path.join(dataDir(), STORAGE_RESERVE_NAME);

/** Serialize recovery and replenishment. A released slice belongs to the
 * recovery attempt until its transaction has committed or rolled back. */
async function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
  const before = state.tail;
  const done = Promise.withResolvers<void>();
  state.tail = done.promise;
  await before;
  try { return await work(); } finally { done.resolve(); }
}

/** Allocate real blocks, never a sparse file. A failed refill keeps the
 * portion already held and does not compete with a recovery. */
export function replenishStorageReserve(read: () => StorageState = readStorageState): Promise<void> {
  return exclusive(() => {
    const space = read();
    if (space.free <= space.threshold + STORAGE_RESERVE_BYTES) return;
    const fd = openSync(reservePath(), "a+", 0o600);
    try {
      const held = fstatSync(fd).size;
      const block = Buffer.alloc(STORAGE_MB, 1);
      for (let bytes = held; bytes < STORAGE_RESERVE_BYTES; bytes += block.length) {
        writeSync(fd, block, 0, Math.min(block.length, STORAGE_RESERVE_BYTES - bytes));
      }
    } catch (error) {
      if (!isStorageExhausted(error)) throw error;
    } finally { closeSync(fd); }
  });
}

function releaseSlice(): boolean {
  let fd: number;
  try { fd = openSync(reservePath(), "r+"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const held = fstatSync(fd).size;
    if (!held) return false;
    ftruncateSync(fd, Math.max(0, held - STORAGE_RELEASE_BYTES));
    return true;
  } finally { closeSync(fd); }
}

/** Only retry a transaction that rolled back or an idempotent cleanup step.
 * Bodies, password derivations and already committed work stay outside. */
export async function withStorageRecovery<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { if (!isStorageExhausted(error)) throw error; }
  return exclusive(async () => {
    const fence = await fenceStorageWriters();
    try {
      for (let attempt = 0; attempt <= STORAGE_RESERVE_BYTES / STORAGE_RELEASE_BYTES; attempt++) {
        // Settlement itself may have freed partial files. Try those bytes first.
        try { return await work(); }
        catch (error) { if (!isStorageExhausted(error)) throw error; }
        if (attempt === STORAGE_RESERVE_BYTES / STORAGE_RELEASE_BYTES || !releaseSlice()) break;
      }
      throw storageExhausted();
    } finally { fence.release(); }
  });
}

/** Cleanup helpers call this only around writes, after their work drains. */
export type StorageRecovery = typeof withStorageRecovery;

export async function startStorageReserve(): Promise<void> {
  await replenishStorageReserve();
  if (!state.timer) {
    state.timer = setInterval(() => {
      void replenishStorageReserve().catch(error => console.warn("[storage] reserve refill failed:", error));
    }, 30_000);
    state.timer.unref();
  }
}

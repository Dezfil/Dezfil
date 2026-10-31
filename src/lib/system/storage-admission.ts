import { ApiError } from "@/lib/api/errors";
import { readStorageState, STORAGE_MB, storageMessage } from "./storage-state";

/** A declaration covers the transfer, never promises its conversion will fit. */
export function admitStorageWrite(declaredBytes = 0): void {
  const state = readStorageState();
  if (state.full || (Number.isFinite(declaredBytes) && declaredBytes > state.free - state.threshold)) {
    throw new ApiError("storage_full", storageMessage(state), 409);
  }
}

/** Check undeclared transfers each 4 MB, before forwarding that chunk. */
export function checkUndeclaredStorage(seen: number, chunkBytes: number, declaredBytes: number): void {
  if (Number.isFinite(declaredBytes) && declaredBytes >= 0) return;
  const interval = 4 * STORAGE_MB;
  if (Math.floor(seen / interval) !== Math.floor((seen - chunkBytes) / interval)) admitStorageWrite();
}

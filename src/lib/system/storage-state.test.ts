import { describe, expect, it, vi } from "vitest";
import { dataDir } from "@/lib/config";
import { readStorageState, roundedStorageState, storageMessage, STORAGE_FULL_BYTES, STORAGE_MB } from "./storage-state";

describe("storage state", () => {
  it("includes the threshold and emits only the two transitions", () => {
    const previous = { full: false };
    const log = vi.fn();
    const read = (free: number) => readStorageState(() => ({ free, total: 2048 * STORAGE_MB }), previous, log);
    expect(read(STORAGE_FULL_BYTES + 1).full).toBe(false);
    expect(read(STORAGE_FULL_BYTES).full).toBe(true);
    expect(read(0).full).toBe(true);
    expect(read(STORAGE_FULL_BYTES + 1).full).toBe(false);
    read(STORAGE_FULL_BYTES + 2);
    expect(log.mock.calls).toEqual([
      [`[storage] full: ${dataDir()}; ${STORAGE_FULL_BYTES} bytes free`],
      [`[storage] available: ${dataDir()}; ${STORAGE_FULL_BYTES + 1} bytes free`],
    ]);
  });
  it("rounds disclosure without rounding the admission decision", () => {
    const state = readStorageState(() => ({ free: STORAGE_FULL_BYTES + 1, total: 2048 * STORAGE_MB + 1 }), { full: false });
    expect(roundedStorageState(state)).toEqual({ full: false, free: STORAGE_FULL_BYTES, total: 2048 * STORAGE_MB, threshold: STORAGE_FULL_BYTES });
    expect(storageMessage(state)).toBe("This instance's storage is full: 512 MB free of 2048 MB. Delete datasets or maps you no longer need, or ask an admin to free space.");
  });
  it("does not turn a failed reading into invented capacity", () => {
    expect(() => readStorageState(() => { throw new Error("unreadable"); })).toThrow("unreadable");
  });
});

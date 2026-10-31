import { afterEach, expect, it } from "vitest";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { StorageWriter, storageWritersState } from "./storage-fence";
import { replenishStorageReserve, STORAGE_RELEASE_BYTES, STORAGE_RESERVE_BYTES, STORAGE_RESERVE_NAME, withStorageRecovery } from "./storage-reserve";
import { STORAGE_FULL_BYTES } from "./storage-state";
import { placeOf } from "./storage-places";

const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
const file = () => path.join(dataDir(), STORAGE_RESERVE_NAME);
const plenty = () => ({ full: false, free: 4 * STORAGE_FULL_BYTES, total: 8 * STORAGE_FULL_BYTES, threshold: STORAGE_FULL_BYTES });
afterEach(() => { rmSync(file(), { force: true }); rmSync(file() + ".backup", { force: true }); });

it("allocates real blocks, survives a backup and restore, and classifies as retained Other", async () => {
  await replenishStorageReserve(plenty);
  expect(statSync(file()).size).toBe(STORAGE_RESERVE_BYTES);
  expect(statSync(file()).blocks * 512).toBeGreaterThanOrEqual(STORAGE_RESERVE_BYTES);
  copyFileSync(file(), file() + ".backup"); rmSync(file()); copyFileSync(file() + ".backup", file());
  await replenishStorageReserve(plenty);
  expect(statSync(file()).size).toBe(STORAGE_RESERVE_BYTES);
  const empty = new Set<string>();
  expect(placeOf([STORAGE_RESERVE_NAME], { tableFiles: empty, tileLayers: empty, templateFiles: empty, pictureFiles: empty, pictureRecords: empty })).toBe("other");
});

it("holds the fence through settlement before releasing a slice and retrying", async () => {
  await replenishStorageReserve(plenty);
  const stopped = Promise.withResolvers<void>();
  const writer = new StorageWriter(error => { expect(error.code).toBe("storage_exhausted"); stopped.resolve(); });
  let calls = 0;
  const recovery = withStorageRecovery(() => {
    calls++;
    if (statSync(file()).size === STORAGE_RESERVE_BYTES) throw full;
    expect(storageWritersState()).toEqual({ fenced: true, live: 0 });
    return "committed";
  });
  await stopped.promise;
  expect(statSync(file()).size).toBe(STORAGE_RESERVE_BYTES);
  writer.close();
  expect(await recovery).toBe("committed");
  expect(calls).toBe(3);
  expect(statSync(file()).size).toBe(STORAGE_RESERVE_BYTES - STORAGE_RELEASE_BYTES);
  expect(storageWritersState().fenced).toBe(false);
  await replenishStorageReserve(plenty);
  expect(statSync(file()).size).toBe(STORAGE_RESERVE_BYTES);
});

it("bounds retries when every slice is exhausted, then permits later recovery", async () => {
  await replenishStorageReserve(plenty);
  let calls = 0;
  await expect(withStorageRecovery(() => { calls++; throw full; })).rejects.toMatchObject({ code: "storage_exhausted", status: 507 });
  expect(calls).toBe(10);
  expect(statSync(file()).size).toBe(0);
  expect(await withStorageRecovery(() => 42)).toBe(42);
});

it("neither refills under the threshold nor spends the reserve on permission errors", async () => {
  await replenishStorageReserve(() => ({ ...plenty(), free: 0, full: true }));
  expect(existsSync(file())).toBe(false);
  await replenishStorageReserve(plenty);
  const permission = Object.assign(new Error("permission"), { code: "EACCES" });
  await expect(withStorageRecovery(() => { throw permission; })).rejects.toBe(permission);
  expect(statSync(file()).size).toBe(STORAGE_RESERVE_BYTES);
});

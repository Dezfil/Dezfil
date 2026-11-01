import { expect, it, vi } from "vitest";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import * as ownership from "@/lib/ingest/file-ownership";
import { replenishStorageReserve, STORAGE_RELEASE_BYTES, STORAGE_RESERVE_BYTES, STORAGE_RESERVE_NAME } from "@/lib/system/storage-reserve";
import { STORAGE_FULL_BYTES } from "@/lib/system/storage-state";
import { eraseAccountStaging, leaseStagingInputs, prepareStagingInput, removeStagingInput, stagingForTests } from "./staging";

it("recovers a refused staging cleanup that began before deletion", async () => {
  const scope = testAccountScope();
  const input = await prepareStagingInput(scope, "geocode", file => writeFile(file, "staged data"));
  const lease = leaseStagingInputs(scope, [input]);
  await replenishStorageReserve(() => ({ full: false, free: 4 * STORAGE_FULL_BYTES, total: 8 * STORAGE_FULL_BYTES, threshold: STORAGE_FULL_BYTES }));
  const reserve = path.join(process.env.DEZFIL_DATA_DIR!, STORAGE_RESERVE_NAME);
  const remove = ownership.removeAccountFile;
  const fault = vi.spyOn(ownership, "removeAccountFile").mockImplementation(async (...args) => {
    if (statSync(reserve).size === STORAGE_RESERVE_BYTES) throw Object.assign(new Error("cleanup refused"), { code: "ENOSPC" });
    return remove(...args);
  });
  const earlier = removeStagingInput(input).catch(error => error);
  const erased = eraseAccountStaging(scope.accountId);
  const answer = erased.catch(error => error);
  try {
    lease.release();
    expect(await earlier).toMatchObject({ code: "ENOSPC" });
    expect(await answer).toBeUndefined();
    expect(stagingForTests()).toEqual([]);
    expect(ownership.accountFiles(scope.accountId)).toEqual([]);
    expect(statSync(reserve).size).toBe(STORAGE_RESERVE_BYTES - STORAGE_RELEASE_BYTES);
  } finally {
    lease.release(); fault.mockRestore(); await answer;
    await removeStagingInput(input); closeMetadataDb();
  }
});

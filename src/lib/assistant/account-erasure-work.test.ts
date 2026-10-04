import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { pendingActions } from "./pending";
import { assistantRuns } from "./runs";
import { eraseAccountWork } from "./account-erasure-work";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "assistant-erasure-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); });
afterEach(async () => { vi.restoreAllMocks(); pendingActions.resetForTests(); assistantRuns.resetForTests(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
it("removes only the target's receipts from every compiled store", async () => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  assistantRuns.reserve(target); const kept = assistantRuns.reserve(control);
  vi.resetModules(); const other = await import("./account-erasure-work");
  const freshScope = (await import("@/lib/test-support/accounts")).testAccountScope(undefined, "control");
  expect((await import("./runs")).assistantRuns.read(freshScope, kept.id)).toEqual(kept);
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  await other.eraseAccountWork("target", { jobs: [], runs: [] }, metadataDb());
  expect(assistantRuns.entriesForTests("target")).toEqual([]); expect(assistantRuns.read(control, kept.id)).toEqual(kept);
});
it("refuses a merely deactivated account before touching retained state", async () => {
  const target = testAccountScope(undefined, "target"); const kept = assistantRuns.reserve(target);
  metadataDb().exec("UPDATE accounts SET status = 'deactivated' WHERE id = 'target'");
  await expect(eraseAccountWork("target", { jobs: [], runs: [] }, metadataDb())).rejects.toThrow("deleting");
  expect(assistantRuns.entriesForTests("target")).toEqual([kept.id]);
});

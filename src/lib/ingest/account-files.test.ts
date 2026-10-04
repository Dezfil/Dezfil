import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { registerAccountFile, accountFiles, eraseAccountFiles } from "./account-files";
import { retireArtifact, retirementsSettled } from "./retire";
import { trackInflight } from "@/lib/query/inflight";
import { prepareStagingInput, leaseStagingInputs, stagingForTests } from "@/lib/query/staging";
import { discoverFiles } from "../../../test-support/account-erasure-discovery";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "files-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); testAccountScope(undefined, "target"); testAccountScope(undefined, "control"); });
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
async function plant(owner: string, file: string) {
  registerAccountFile(owner, path.join(directory, file)); await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), `${owner} content`);
}
const deleting = () => metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
it("removes registered generations, sketches and abandoned scratch against a full independent listing", async () => {
  const pairs = ["tables/current.parquet", "tables/retired.parquet", "tables/sketch.parquet", "tmp/upload", "tmp/extraction/nested", "exports/prepared.zip", "tiles/scratch/export.csv"];
  for (const file of pairs) { await plant("target", file); await plant("control", file.replace(/\/(?!.*\/)/, "/control-")); }
  const unknown = "tables/unregistered-uuid.parquet"; await writeFile(path.join(directory, unknown), "unattributed control");
  const before = discoverFiles(directory), ids = ["file:tables", "file:tmp", "file:exports", "file:account-files"];
  const stores = Object.fromEntries(ids.map(id => [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]]));
  const probes = Object.fromEntries(ids.map(id => [id, { populate() {}, dispose() {}, observe() {
    const files = discoverFiles(directory), prefix = id === "file:account-files" ? "file-owners/" : `${id.slice(5)}/`;
    if (id === "file:account-files") return { target: accountFiles("target"), control: accountFiles("control") };
    return { target: files.filter(f => f.startsWith(prefix) && pairs.includes(f)), control: files.filter(f => f.startsWith(prefix) && !pairs.includes(f)) };
  } }]));
  deleting(); await proveErasure({ ...erasureInventory, stores }, probes, () => eraseAccountFiles("target", [], metadataDb()));
  const removed = new Set([...pairs, ...before.filter(f => f.startsWith("file-owners/") && !discoverFiles(directory).includes(f))]);
  expect(discoverFiles(directory)).toEqual(before.filter(f => !removed.has(f)));
});
it("holds current and retired artifacts until readers release across two module graphs", async () => {
  await plant("target", "tables/retired.parquet"); const reader = Promise.withResolvers<void>(); trackInflight(reader.promise);
  retireArtifact(path.join(directory, "tables/retired.parquet")); deleting();
  vi.resetModules(); const second = await import("./account-files"); let done = false;
  const erased = second.eraseAccountFiles("target", [], metadataDb()).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false); expect(discoverFiles(directory)).toContain("tables/retired.parquet");
  reader.resolve(); await erased; await retirementsSettled(); expect(discoverFiles(directory)).not.toContain("tables/retired.parquet");
});
it("does not swallow retirement or unlink failures, and keeps enough ownership to retry", async () => {
  await plant("target", "tables/blocked.parquet");
  await rm(path.join(directory, "tables/blocked.parquet")); await mkdir(path.join(directory, "tables/blocked.parquet")); await writeFile(path.join(directory, "tables/blocked.parquet/held"), "target");
  retireArtifact(path.join(directory, "tables/blocked.parquet"));
  await expect(retirementsSettled()).rejects.toThrow(); deleting();
  await expect(eraseAccountFiles("target", [], metadataDb())).rejects.toThrow();
  expect(accountFiles("target")).toContain("tables/blocked.parquet");
  await rm(path.join(directory, "tables/blocked.parquet"), { recursive: true }); await eraseAccountFiles("target", [], metadataDb()); expect(accountFiles("target")).toEqual([]);
});
it("erases abandoned staging only after held leases and writes settle", async () => {
  const target = testAccountScope(undefined, "target");
  const input = await prepareStagingInput(target, "geocode", file => writeFile(file, "target stage"));
  const lease = leaseStagingInputs(target, [input]);
  deleting(); let done = false; const erased = eraseAccountFiles("target", [], metadataDb()).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false);
  expect(() => lease.assertLive()).toThrow();
  lease.release(); await erased; expect(discoverFiles(directory).filter(f => f.endsWith(".parquet"))).toEqual([]);
  expect(stagingForTests().some(s => s.owner === "target")).toBe(false);
});

it("drains populated refresh and sketch lanes and staging capabilities while independent work remains held", async () => {
  const { beginRefresh, endRefresh, refreshUnit, refreshFencesForTests } = await import("./fence");
  const { serializeSketchMutation, sketchWritesForTests } = await import("@/lib/sketch/store");
  const { stagingForTests, removeStagingInput, prepareStagingInput: prepare, leaseStagingInputs: leaseStage } = await import("@/lib/query/staging");
  const { testAccountScope: freshScope } = await import("@/lib/test-support/accounts");
  const target = freshScope(undefined, "target"), control = freshScope(undefined, "control");
  const stages = await Promise.all([target, control].map(s => prepare(s, "isochrone", f => writeFile(f, s.accountId))));
  const lease = leaseStage(target, [stages[0]]);
  const unit = (scope: typeof target) => refreshUnit(scope, { id: `${scope.accountId}-dataset` } as Parameters<typeof refreshUnit>[1]);
  const targetUnit = unit(target), controlUnit = unit(control);
  beginRefresh(targetUnit, "same"); beginRefresh(controlUnit, "same");
  const targetHold = Promise.withResolvers<void>(), controlHold = Promise.withResolvers<void>();
  const writes = [serializeSketchMutation("target-dataset", () => targetHold.promise), serializeSketchMutation("control-dataset", () => controlHold.promise)];
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => /ingest\/fence|sketch\/store|query\/staging/.test(id)));
  const probes = Object.fromEntries(Object.keys(stores).map(id => [id, { populate() {}, dispose() {}, observe() {
    const entries = id.includes("fence") ? refreshFencesForTests() : id.includes("sketch") ? sketchWritesForTests() : stagingForTests().map(s => s.owner);
    return { target: entries.filter(v => v.includes("target")), control: entries.filter(v => v.includes("control")) };
  } }]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      deleting(); let done = false; const erase = eraseAccountFiles("target", [{ id: "target-dataset", file: "tables/captured.parquet" }], metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false);
      targetHold.resolve(); endRefresh(targetUnit); lease.release(); await erase;
    });
  } finally {
    targetHold.resolve(); controlHold.resolve(); endRefresh(targetUnit); endRefresh(controlUnit); lease.release();
    await Promise.all(writes); await Promise.all(stages.map(removeStagingInput));
    (await import("@/lib/metadata/db")).closeMetadataDb();
  }
});

it("removes populated retirement promises while a later independent retirement stays held", async () => {
  const { retirementsForTests } = await import("./retire");
  const first = Promise.withResolvers<void>(), later = Promise.withResolvers<void>();
  await plant("target", "tables/target-retired.parquet"); await plant("control", "tables/control-retired.parquet");
  trackInflight(first.promise); retireArtifact(path.join(directory, "tables/target-retired.parquet"));
  const id = "memory:src/lib/ingest/retire.ts#pending";
  const observe = () => ({ target: retirementsForTests().filter(f => f.includes("target-retired")), control: retirementsForTests().filter(f => f.includes("control-retired")) });
  // Populate the control after the target's retirement captured its readers.
  trackInflight(later.promise); retireArtifact(path.join(directory, "tables/control-retired.parquet"));
  try {
    await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, { [id]: { populate() {}, dispose() {}, observe } }, async () => {
      first.resolve(); await retirementsSettled([path.join(directory, "tables/target-retired.parquet")]);
    });
  } finally { first.resolve(); later.resolve(); await retirementsSettled(); }
});
it("waits a staging writer admitted before erasure and discards its late candidate", async () => {
  const { prepareStagingInput: prepare, stagingForTests } = await import("@/lib/query/staging");
  const { testAccountScope: freshScope } = await import("@/lib/test-support/accounts");
  const write = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const prepared = prepare(freshScope(undefined, "target"), "geocode", async file => { started.resolve(); await write.promise; await writeFile(file, "late target"); });
  const rejected = expect(prepared).rejects.toMatchObject({ code: "authentication_required" });
  await started.promise; expect(stagingForTests().some(s => s.owner === "target")).toBe(true); deleting();
  let done = false; const erased = eraseAccountFiles("target", [], metadataDb()).then(() => { done = true; });
  await new Promise(r => setImmediate(r)); expect(done).toBe(false);
  write.resolve(); await rejected; await erased; expect(stagingForTests().some(s => s.owner === "target")).toBe(false);
  expect(accountFiles("target")).toEqual([]);
  (await import("@/lib/metadata/db")).closeMetadataDb();
});

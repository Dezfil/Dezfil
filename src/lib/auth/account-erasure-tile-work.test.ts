import { afterEach, beforeEach, expect, it, vi } from "vitest";
const driver = vi.hoisted(() => ({ renameHold: null as null | ReturnType<typeof Promise.withResolvers<void>>, renameStarted: null as null | ReturnType<typeof Promise.withResolvers<void>>, hold: null as null | ReturnType<typeof Promise.withResolvers<void>>, started: null as null | ReturnType<typeof Promise.withResolvers<void>>, fail: false, controlId: "", controlHold: null as null | ReturnType<typeof Promise.withResolvers<void>> }));
vi.mock("node:fs/promises", async load => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (driver.renameHold) { driver.renameStarted?.resolve(); await driver.renameHold.promise; }
    return fs.rename(...args);
  } };
});
vi.mock("@/lib/tiles/export", () => ({ exportGeoJsonSeq: async (_scope: unknown, _input: unknown, file: string) => {
  const { writeFile } = await import("node:fs/promises"); await writeFile(file, "private tile input");
  driver.started?.resolve(); await driver.hold?.promise;
  if (driver.controlId && file.includes(driver.controlId)) await driver.controlHold?.promise; if (driver.fail) throw new Error("retained failure"); return 1;
} }));
// A stand-in tiler process, as execFile hands one back: it writes its
// archive late, exits, and only then answers, as a real run does.
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return { execFile: (_file: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
    const child = Object.assign(new EventEmitter(), { pid: 4_194_304, kill: () => true });
    void import("node:fs/promises").then(fs => fs.writeFile(args[args.indexOf("-o") + 1], "late archive"))
      .then(() => { child.emit("exit", 0, null); callback(null, "", ""); });
    return child;
  } };
});
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { privateTileAccess } from "@/lib/tiles/access";
import { ensureTiles, eraseTileArtifacts, tileBuildsSettled, tileBuildStateForTests, invalidateTileBuild, resetTileBuilds } from "@/lib/tiles/build";
import { runningTileInputsForTests } from "@/lib/tiles/evidence";
import { erasureInventory } from "./account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { discoverFiles } from "../../../test-support/account-erasure-discovery";
import { ingestFile } from "@/lib/ingest/ingest";
import { drainAccountWork } from "./account-deletion-admission";
import { getTileRecord } from "@/lib/metadata/tiles";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
let layers: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "tile-work-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetTileBuilds();
  testAccountScope(undefined, "target"); layers = {};
  for (const owner of ["target", "control"]) {
    const map = createMap(testAccountScope(undefined, owner), "Same").id, id = `${map}-layer`; layers[owner] = id;
    metadataDb().prepare("INSERT INTO layers(id,map_id,name,sql,style,ordinal,created_at,updated_at) VALUES(?,?, 'Same','SELECT 1','{}',0,'time','time')").run(id, map);
  }
});
afterEach(async () => { driver.renameHold?.resolve(); driver.renameHold = null; driver.renameStarted = null; driver.hold?.resolve(); driver.controlHold?.resolve(); driver.controlHold = null; driver.controlId = ""; driver.hold = null; driver.started = null; driver.fail = false; await tileBuildsSettled(); resetTileBuilds(); (await import("@/lib/metadata/db")).closeMetadataDb(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
const input = (id: string, sql = "SELECT 1") => ({ layerId: id, sql, filters: [], geometryColumn: "geom", columns: [], projection: "", inputs: { catalogue: false, datasets: [{ id: "target-dataset", file: "tables/private.parquet" }] } });
it("fences and settles held and queued builds across module graphs before clearing their state and scratch", async () => {
  driver.hold = Promise.withResolvers<void>(); driver.started = Promise.withResolvers<void>();
  const scope = testAccountScope(undefined, "target"), access = privateTileAccess(scope, layers.target);
  ensureTiles(access, input(layers.target)); await driver.started.promise;
  ensureTiles(access, input(layers.target, "SELECT 2"));
  expect(tileBuildStateForTests()).toMatchObject({ active: [layers.target], pending: [layers.target] });
  expect(runningTileInputsForTests()).toContain(layers.target);
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  vi.resetModules(); const other = await import("./account-erasure-derivatives");
  let done = false; const erased = other.eraseAccountDerivatives("target", { maps: [], layers: [{ id: layers.target, mapId: "captured" }], datasets: [{ id: "target-dataset" }] }, metadataDb()).then(() => { done = true; });
  try { await new Promise(r => setImmediate(r)); expect(done).toBe(false); }
  finally { driver.hold.resolve(); await erased; }
  expect(tileBuildStateForTests()).toEqual({ active: [], pending: [], failures: [], generations: [] });
  expect(runningTileInputsForTests()).toEqual([]); expect(discoverFiles(directory).some(f => f.includes(layers.target))).toBe(false);
});
it("erases populated failure and generation stores with an independent retained control", async () => {
  driver.fail = true;
  for (const owner of ["target", "control"]) {
    const scope = testAccountScope(undefined, owner), access = privateTileAccess(scope, layers[owner]);
    invalidateTileBuild(layers[owner]); ensureTiles(access, input(layers[owner]));
  }
  await tileBuildsSettled();
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => /tiles\/build.ts#(failures|generations)$/.test(id)));
  const probes = Object.fromEntries(Object.keys(stores).map(id => [id, { populate() {}, dispose() {}, observe() {
    const values = tileBuildStateForTests()[id.endsWith("failures") ? "failures" : "generations"];
    return { target: values.filter(v => v === layers.target), control: values.filter(v => v === layers.control) };
  } }]));
  await proveErasure({ ...erasureInventory, stores }, probes, () => eraseTileArtifacts([layers.target]));
});

it("iterates active, queued and recorded-input memory fixtures while an independent build stays held", async () => {
  driver.hold = Promise.withResolvers<void>(); driver.controlHold = Promise.withResolvers<void>(); driver.controlId = layers.control;
  for (const owner of ["target", "control"]) {
    const access = privateTileAccess(testAccountScope(undefined, owner), layers[owner]);
    ensureTiles(access, input(layers[owner])); ensureTiles(access, input(layers[owner], "SELECT 2"));
  }
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => /tiles\/build.ts#(active|pending|chain)$|tiles\/evidence.ts#running$/.test(id)));
  const probes = Object.fromEntries(Object.keys(stores).map(id => [id, { populate() {}, dispose() {}, observe() {
    const values = id.endsWith("running") ? runningTileInputsForTests() : tileBuildStateForTests()[id.endsWith("pending") ? "pending" : "active"];
    return { target: values.filter(v => v === layers.target), control: values.filter(v => v === layers.control) };
  } }]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      let done = false; const erased = eraseTileArtifacts([layers.target]).then(() => { done = true; });
      await new Promise(r => setTimeout(r, 30)); expect(done).toBe(false);
      driver.hold!.resolve(); await erased;
    });
  } finally { driver.hold.resolve(); driver.controlHold.resolve(); await tileBuildsSettled(); }
});

it("rejects a foreign-input archive crossing acceptance during rename and holds its settlement", async () => {
  const source = path.join(directory, "input.csv"); await writeFile(source, "value\n42\n");
  const dataset = await ingestFile(testAccountScope(undefined, "target"), source, "same.csv");
  driver.renameHold = Promise.withResolvers<void>(); driver.renameStarted = Promise.withResolvers<void>();
  const access = privateTileAccess(testAccountScope(undefined, "control"), layers.control);
  ensureTiles(access, { ...input(layers.control), inputs: { catalogue: false, datasets: [{ id: dataset.id, file: dataset.file }] } });
  await driver.renameStarted.promise;
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const drained = drainAccountWork("target").then(() => { done = true; });
  try { await new Promise(r => setImmediate(r)); expect(done).toBe(false); }
  finally { driver.renameHold.resolve(); }
  await drained; await tileBuildsSettled();
  expect(getTileRecord(layers.control)?.state).not.toBe("ready");
  expect(discoverFiles(directory).some(file => file.includes(layers.control))).toBe(false);
  driver.renameHold = null;
  ensureTiles(access, { ...input(layers.control), inputs: { catalogue: false, datasets: [] } });
  await tileBuildsSettled(); expect(getTileRecord(layers.control)?.state).toBe("ready");
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { connectQueryInstance, resetQueryInstance, engineStateForTests, connectionStampForTests, withConnection } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { DuckDBInstance } from "@duckdb/node-api";
import { catalogRelationsForTests, artifactRelations } from "./catalog-state";
import { catalogGenerationOf } from "@/lib/duckdb";
import { registerTableViews, mountedViewsForTests } from "./views";
import { mountPlanOf } from "./mount-plan";
import { noteCatalogue, recordedInputs, inputRecorderForTests } from "./evaluation-inputs";
import { inspectionCache } from "@/lib/geometry/inspection-cache";
import { eraseAccountQueryState } from "./account-erasure-query";
import { erasureInventory } from "@/lib/auth/account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "query-erasure-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); resetQueryInstance(); testAccountScope(undefined, "target"); testAccountScope(undefined, "control"); });
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
it("drains leased native connections and clears populated mounted views and input state across module graphs", async () => {
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  const source = path.join(directory, "input.csv"); await writeFile(source, "label,lon,lat\nsentinel,1,2\n");
  const a = await ingestFile(target, source, "same.csv"), b = await ingestFile(control, source, "same.csv");
  const first = await connectQueryInstance(), second = await connectQueryInstance();
  await registerTableViews(target, first); await registerTableViews(control, second); noteCatalogue(first); noteCatalogue(second);
  expect(recordedInputs(first).datasets[0].id).toBe(a.id); expect(recordedInputs(second).datasets[0].id).toBe(b.id);
  const outsideControl = { store: "table:data_tables", entries: [a.id, b.id] };
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => /duckdb|query\/(mount-plan|views|evaluation-inputs)/.test(id) && !/(collecting|collections|nativeCreating|clear)/.test(id) && erasureInventory.stores[id as keyof typeof erasureInventory.stores].action !== "retain"));
  const probes = Object.fromEntries(Object.keys(stores).map(id => [id, { populate() {}, dispose() {}, observe() {
    const read = (conn: typeof first) => {
      if (id.endsWith("#connectionGenerations")) return connectionStampForTests(conn);
      if (id.endsWith("#queryInstancePromise")) return engineStateForTests().hardened;
      if (id.endsWith("#instancePromise")) return engineStateForTests().trusted;
      if (id.endsWith("#nativeInstances")) return engineStateForTests().instances > 0;
      if (id.endsWith("#leases")) return engineStateForTests().leases > 0;
      if (id.endsWith("#plans")) return !!mountPlanOf(conn);
      if (id.endsWith("#mounted")) return mountedViewsForTests(conn).length > 0;
      if (id.endsWith("#recorders")) return inputRecorderForTests(conn);
      throw new Error(`Unbound probe ${id}`);
    };
    return { target: read(first) ? [a.id] : [], control: read(second) ? [b.id] : [], outsideControl };
  } }]));
  const catalogStores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id, rule]) => id.includes("query/catalog-state") && rule.action !== "retain"));
  for (const id of Object.keys(catalogStores)) probes[id] = { populate() {}, dispose() {}, observe() {
    const keys = catalogRelationsForTests(); return { target: keys.filter(k => k.includes(a.id)), control: keys.filter(k => k.includes(b.id)), outsideControl };
  } };
  const oldRelations = artifactRelations(catalogGenerationOf(first));
  const oldKey = [...oldRelations.keys()][0], oldValue = oldRelations.get(oldKey)!;
  try {
    await proveErasure({ ...erasureInventory, stores: { ...stores, ...catalogStores } }, probes, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'"); vi.resetModules();
      const other = await import("./account-erasure-query"); let done = false;
      const erased = other.eraseAccountQueryState("target", metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false);
      expect((await first.runAndReadAll('SELECT label FROM same')).getRowObjects()).toEqual([{ label: "sentinel" }]);
      first.disconnectSync(); await new Promise(r => setImmediate(r)); expect(done).toBe(false);
      second.disconnectSync(); await erased;
    });
    oldRelations.set(oldKey, oldValue); expect(catalogRelationsForTests()).toEqual([]);
    expect(recordedInputs(first).datasets).toEqual([]); expect(recordedInputs(second).datasets).toEqual([]);
    // Independent durable input still mounts on the fresh hardened instance.
    const { testAccountScope: freshScope } = await import("@/lib/test-support/accounts");
    const { connectQueryInstance: connect } = await import("@/lib/duckdb");
    const { registerTableViews: mount } = await import("./views");
    const conn = await connect(); try { await mount(freshScope(undefined, "control"), conn); expect((await conn.runAndReadAll('SELECT label FROM same')).getRowObjects()).toEqual([{ label: "sentinel" }]); } finally { conn.disconnectSync(); }
  } finally { first.disconnectSync(); second.disconnectSync(); (await import("@/lib/metadata/db")).closeMetadataDb(); }
});
it("drains populated inspection promises and forces fresh inspections after late completion", async () => {
  const cache = inspectionCache<string>(), hold = Promise.withResolvers<string>(); let calls = 0;
  const table = (id: string) => ({ id, file: `tables/${id}.parquet` }) as Parameters<typeof cache>[0];
  const first = cache(table("target"), () => { calls++; return hold.promise; });
  await cache(table("control"), async () => { calls++; return "control result"; });
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  let done = false; const erased = eraseAccountQueryState("target", metadataDb()).then(() => { done = true; });
  await new Promise(r => setImmediate(r)); expect(done).toBe(false); hold.resolve("private result"); await first; await erased;
  expect(await cache(table("target"), async () => { calls++; return "fresh"; })).toBe("fresh");
  expect(await cache(table("control"), async () => { calls++; return "fresh control"; })).toBe("fresh control"); expect(calls).toBe(4);
});
it("drains a trusted inspection connection through its actual final statement", async () => {
  const hold = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  const work = withConnection(async conn => { await conn.run("CREATE TABLE private_buffer AS SELECT 'private' AS sentinel"); ready.resolve(); await hold.promise; expect((await conn.runAndReadAll("SELECT * FROM private_buffer")).getRowObjects()).toHaveLength(1); });
  void work.catch(ready.reject);
  await ready.promise; metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'"); let done = false;
  const erased = eraseAccountQueryState("target", metadataDb()).then(() => { done = true; }); await new Promise(r => setImmediate(r)); expect(done).toBe(false);
  hold.resolve(); await work; await erased;
});

it("drains both native instance creations before clearing their late catalogs", async () => {
  const hold = Promise.withResolvers<void>(), create = DuckDBInstance.create.bind(DuckDBInstance);
  const instances: DuckDBInstance[] = [];
  const spy = vi.spyOn(DuckDBInstance, "create").mockImplementation(async (...args) => { await hold.promise; const instance = await create(...args); instances.push(instance); return instance; });
  const hardened = connectQueryInstance().then(c => c.disconnectSync());
  const trusted = withConnection(async c => { await c.run("SELECT 1"); });
  const id = "memory:src/lib/duckdb.ts#nativeCreating";
  try {
    expect(engineStateForTests().creating).toBe(2);
    await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id as keyof typeof erasureInventory.stores] } }, {
      [id]: { populate() {}, dispose() {}, observe: () => ({ target: engineStateForTests().creating ? ["trusted"] : [], control: engineStateForTests().creating ? ["hardened"] : [], outsideControl: { store: "table:accounts", entries: [metadataDb().prepare("SELECT id FROM accounts WHERE id = 'control'").get() ? "control" : "missing"] } }) },
    }, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
      let done = false; const erased = eraseAccountQueryState("target", metadataDb()).then(() => { done = true; });
      await new Promise(r => setImmediate(r)); expect(done).toBe(false); hold.resolve(); await Promise.all([hardened, trusted]); await erased;
      expect(engineStateForTests()).toEqual({ trusted: false, hardened: false, creating: 0, leases: 0, instances: 0 });
      for (const instance of instances) await expect(async () => instance.connect()).rejects.toThrow();
    });
  } finally { hold.resolve(); await Promise.allSettled([hardened, trusted]); spy.mockRestore(); }
});

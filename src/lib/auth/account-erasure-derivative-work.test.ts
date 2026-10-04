import { afterEach, beforeEach, expect, it, vi } from "vitest";
const holds = vi.hoisted(() => ({ image: null as null | ReturnType<typeof Promise.withResolvers<void>>, opened: null as null | ReturnType<typeof Promise.withResolvers<void>>, reader: null as null | ReturnType<typeof Promise.withResolvers<void>>, path: "", controlPath: "", readerControl: null as null | ReturnType<typeof Promise.withResolvers<void>>, handles: 0 }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).includes(holds.path) && String(args[0]).endsWith(".tmp") && holds.image) { holds.opened?.resolve(); await holds.image.promise; }
      return actual.writeFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const reader = holds.controlPath && String(args[0]).includes(holds.controlPath) ? holds.readerControl : String(args[0]).includes(holds.path) ? holds.reader : null;
      if (reader) {
        holds.handles++; const close = handle.close.bind(handle);
        handle.close = async () => { await close(); holds.handles--; };
        holds.opened?.resolve(); await reader.promise;
      }
      return handle;
    },
  };
});
vi.mock("pmtiles", () => ({ PMTiles: class {
  constructor(private source: { getBytes(offset: number, length: number): Promise<unknown> }) {}
  async getHeader() { await this.source.getBytes(0, 1); return { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1, minZoom: 0, maxZoom: 1 }; }
} }));
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { saveThumbnail, thumbnailMutationIds, thumbnailTurnForTests } from "@/lib/map-thumbnails";
import { tileArchiveInfo, tileArchivesForTests } from "@/lib/tiles/serve";
import { seedReadyTiles } from "@/lib/test-support/tile-evidence";
import { tileArchivePath } from "@/lib/tiles/paths";
import { eraseAccountDerivatives } from "./account-erasure-derivatives";
import { erasureInventory } from "./account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
import { discoverFiles } from "../../../test-support/account-erasure-discovery";
const root = process.env.DEZFIL_DATA_DIR!; let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(root, "held-derivatives-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb(); testAccountScope(undefined, "target"); });
afterEach(async () => { holds.image?.resolve(); holds.reader?.resolve(); holds.readerControl?.resolve(); holds.readerControl = null; holds.controlPath = ""; holds.image = null; holds.reader = null; holds.opened = null; holds.path = ""; closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
const inputs = { catalogue: false, datasets: [{ id: "target-dataset", file: "tables/target.parquet" }] };
it("waits a foreign image writer across module graphs, then removes its bytes and turn promise", async () => {
  const scope = testAccountScope(undefined, "control"), map = createMap(scope, "Same").id;
  const independent = createMap(scope, "Independent").id;
  holds.path = ""; holds.image = Promise.withResolvers<void>(); holds.opened = Promise.withResolvers<void>();
  const written = saveThumbnail(scope, map, Buffer.from("late image"), inputs);
  const controlWrite = saveThumbnail(scope, independent, Buffer.from("control image"), { catalogue: false, datasets: [] });
  await holds.opened.promise; expect(thumbnailMutationIds()).toContain(map);
  const writer = thumbnailTurnForTests(map);
  const id = "memory:src/lib/map-thumbnails.ts#turns";
  const probe = { populate() {}, dispose() {}, observe: () => ({ target: thumbnailMutationIds().filter(v => v === map), control: thumbnailMutationIds().filter(v => v === independent),
    outsideControl: { store: "table:maps", entries: (metadataDb().prepare("SELECT id FROM maps ORDER BY id").all() as { id: string }[]).map(r => r.id) } }) };
  await proveErasure({ ...erasureInventory, stores: { [id]: erasureInventory.stores[id] } }, { [id]: probe }, async () => {
    metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
    vi.resetModules(); const other = await import("./account-erasure-derivatives");
    let done = false; const erased = other.eraseAccountDerivatives("target", { maps: [], layers: [], datasets: [{ id: "target-dataset" }] }, metadataDb()).then(() => { done = true; });
    try {
      while (thumbnailTurnForTests(map) === writer) await Promise.race([
        erased.then(() => { throw new Error("Cleanup completed before the image writer settled."); }),
        new Promise(r => setImmediate(r)),
      ]);
      expect(done).toBe(false);
    }
    finally { holds.image!.resolve(); await Promise.all([written, controlWrite]); await erased; }
  });
  expect(discoverFiles(directory).some(f => f.includes(map))).toBe(false);
  expect(discoverFiles(directory)).toContain(`thumbnails/${independent}.png`);
});
it("waits an open archive handle and removes its retained directory cache before completion", async () => {
  const map = createMap(testAccountScope(undefined, "target"), "Same").id, layer = `${map}-layer`;
  metadataDb().prepare("INSERT INTO layers(id,map_id,name,sql,style,ordinal,created_at,updated_at) VALUES(?,?, 'Same','SELECT 1','{}',0,'time','time')").run(layer, map);
  seedReadyTiles(layer, { fingerprint: "held", builtAt: "time", featureCount: 1 }, inputs);
  await mkdir(path.dirname(tileArchivePath(layer)), { recursive: true }); await writeFile(tileArchivePath(layer), "archive");
  const controlMap = createMap(testAccountScope(undefined, "control"), "Independent").id, controlLayer = `${controlMap}-layer`;
  await writeFile(tileArchivePath(controlLayer), "independent archive");
  holds.path = layer; holds.reader = Promise.withResolvers<void>(); holds.opened = Promise.withResolvers<void>();
  holds.controlPath = controlLayer; holds.readerControl = Promise.withResolvers<void>();
  const read = tileArchiveInfo(layer); await holds.opened.promise;
  holds.opened = Promise.withResolvers<void>(); const controlRead = tileArchiveInfo(controlLayer); await holds.opened.promise;
  expect(holds.handles).toBe(2);
  const stores = Object.fromEntries(Object.entries(erasureInventory.stores).filter(([id]) => /tiles\/serve.ts#(archives|reads)$/.test(id)));
  const probes = Object.fromEntries(Object.keys(stores).map(id => [id, { populate() {}, dispose() {}, observe() {
    const values = tileArchivesForTests()[id.endsWith("reads") ? "readers" : "archives"];
    return { target: values.filter(v => v === layer), control: values.filter(v => v === controlLayer) };
  } }]));
  try {
    await proveErasure({ ...erasureInventory, stores }, probes, async () => {
      metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
      let done = false; const erased = eraseAccountDerivatives("target", { maps: [map], layers: [{ id: layer, mapId: map }], datasets: [] }, metadataDb()).then(() => { done = true; });
      try { await new Promise(r => setImmediate(r)); expect(done).toBe(false); expect(holds.handles).toBe(2); }
      finally { holds.reader!.resolve(); await read; await erased; }
      expect(holds.handles).toBe(1);
    });
  } finally { holds.reader.resolve(); holds.readerControl.resolve(); await Promise.all([read, controlRead]); }
  expect(holds.handles).toBe(0); expect(discoverFiles(directory).some(f => f.includes(layer))).toBe(false);
});

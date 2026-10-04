import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { saveThumbnail, saveThemedThumbnail } from "@/lib/map-thumbnails";
import { seedReadyTiles } from "@/lib/test-support/tile-evidence";
import { tileArchivePath } from "@/lib/tiles/paths";
import { eraseAccountDerivatives } from "./account-erasure-derivatives";
import { discoverFiles } from "../../../test-support/account-erasure-discovery";
import { erasureInventory } from "./account-erasure-inventory";
import { proveErasure } from "../../../test-support/account-erasure-proof";
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string, maps: Record<string, string>;
const inputs = (id: string) => ({ catalogue: false, datasets: [{ id, file: `tables/${id}.parquet` }] });
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "derivatives-")); process.env.DEZFIL_DATA_DIR = directory; closeMetadataDb();
  const target = testAccountScope(undefined, "target"), control = testAccountScope(undefined, "control");
  maps = Object.fromEntries(["target", "foreign", "control", "unattributed"].map(name => [name, createMap(name === "target" ? target : control, "Same name").id]));
  await mkdir(path.join(directory, "tiles/scratch"), { recursive: true });
  for (const map of Object.values(maps)) metadataDb().prepare("INSERT INTO layers(id,map_id,name,sql,style,ordinal,created_at,updated_at) VALUES(?,?, 'Same', 'SELECT 1', '{}',0,'time','time')").run(`${map}-layer`, map);
});
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); process.env.DEZFIL_DATA_DIR = root; await rm(directory, { recursive: true, force: true }); });
const captured = () => ({ maps: [maps.target], layers: [{ id: `${maps.target}-layer`, mapId: maps.target }], datasets: [{ id: "target-dataset" }] });
it("erases owned and evidenced foreign derivatives, retaining independent bytes and the named unattributed-image residual", async () => {
  const control = testAccountScope(undefined, "control");
  await saveThumbnail(testAccountScope(undefined, "target"), maps.target, Buffer.from("owned-image"));
  for (const theme of ["light", "dark"] as const) {
    await saveThemedThumbnail(control, maps.foreign, theme, "cycle", Buffer.from(`foreign-${theme}`), inputs("target-dataset"));
    await saveThemedThumbnail(control, maps.control, theme, "cycle", Buffer.from(`control-${theme}`), inputs("control-dataset"));
  }
  await saveThumbnail(control, maps.unattributed, Buffer.from("unattributed-image residual"));
  for (const name of ["target", "foreign", "control"]) {
    const layer = `${maps[name]}-layer`;
    seedReadyTiles(layer, { fingerprint: name, builtAt: "time", featureCount: 1 }, inputs(name === "control" ? "control-dataset" : "target-dataset"));
    await writeFile(tileArchivePath(layer), `${name}-tile-bytes`);
    await writeFile(path.join(directory, "tiles/scratch", `${layer}.abandoned.geojsonl`), `${name}-scratch`);
  }
  const before = discoverFiles(directory), independent = before.filter(f => f.includes(maps.control) || f.includes(maps.unattributed));
  const bytes = await Promise.all(independent.map(f => readFile(path.join(directory, f))));
  const ids = ["file:tiles", "file:tile-scratch", "file:thumbnails", "file:thumbnail-inputs", "file:tile-inputs", "table:layer_tiles"];
  const stores = Object.fromEntries(ids.map(id => [id, erasureInventory.stores[id as keyof typeof erasureInventory.stores]]));
  const probes = Object.fromEntries(ids.map(id => [id, { populate() {}, dispose() {}, observe() {
    const files = id === "table:layer_tiles" ? (metadataDb().prepare("SELECT layer_id FROM layer_tiles").all() as { layer_id: string }[]).map(r => r.layer_id)
      : discoverFiles(directory).filter(f => erasureInventory.files[id as keyof typeof erasureInventory.files].some(pattern => f.startsWith(pattern.split("*")[0])));
    return { target: files.filter(f => f.includes(maps.target) || f.includes(maps.foreign)), control: files.filter(f => f.includes(maps.control) || f.includes(maps.unattributed)) };
  } }]));
  metadataDb().exec("UPDATE accounts SET status = 'deleting' WHERE id = 'target'");
  await proveErasure({ ...erasureInventory, stores }, probes, () => eraseAccountDerivatives("target", captured(), metadataDb()));
  expect(discoverFiles(directory)).toEqual(before.filter(f => !f.includes(maps.target) && !f.includes(maps.foreign)));
  expect(await Promise.all(independent.map(f => readFile(path.join(directory, f))))).toEqual(bytes);
});

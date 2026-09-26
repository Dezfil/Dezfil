import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { isolateScenario, storeContents } from "./testing/store-isolation";

/**
 * One scenario, one clean store, on the live path (the measurement
 * definition's "seeded on a clean instance"). The first live run of
 * accumulated every seed because the live path
 * skipped the reset: by its fifth scenario the instance held nine maps and
 * the model asked which one was meant. Here a second seed on the live path
 * must see only its own map and its own tables, the directory kept for the
 * standalone that serves from it.
 */
let dir: string;
beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-isolation-"));
  vi.stubEnv("DEZFIL_DATA_DIR", dir);
  closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

async function seed(name: string) {
  const file = path.join(dir, `${name}-${Date.now().toString(36)}.geojson`);
  await writeFile(file, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { n: 1 }, geometry: { type: "Point", coordinates: [13.4, 52.5] } }] }));
  const table = (await ingestFile(file, path.basename(file))).name;
  const map = createMap(name);
  await createLayer(map.id, { name: "Parks", sql: `SELECT * FROM ${table}` });
  return { map, table };
}

describe("the live path isolates each scenario", () => {
  it("a second seed sees only its own map and tables; the directory the standalone serves from stays", async () => {
    await isolateScenario({ live: true, dir });
    const first = await seed("M1");
    expect((await storeContents()).maps).toEqual(["M1"]);
    await isolateScenario({ live: true, dir });
    // Seeded defect on the shipped harness: the live path reset nothing, so the second seed observes the first's map.
    expect((await storeContents()).maps).toEqual([]);
    expect((await storeContents()).tables).toEqual([]);
    const second = await seed("M2");
    const contents = await storeContents();
    expect(contents.maps).toEqual(["M2"]);
    expect(contents.tables).toEqual([second.table]);
    expect(contents.tables).not.toContain(first.table);
    expect(existsSync(dir)).toBe(true);
  });
  it("the scripted path empties its private directory whole", async () => {
    await seed("M1");
    await isolateScenario({ live: false, dir });
    closeMetadataDb(); resetQueryInstance();
    expect((await storeContents()).maps).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

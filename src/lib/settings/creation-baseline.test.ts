import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { retirementsSettled } from "@/lib/ingest/retire";
import { creationBaseline } from "@/lib/test-support/creation-baseline";

/**
 * With every instance default at the product's value, a new map and the
 * layers added to it are stored exactly as the same calls stored them
 * before instance defaults existed: field for field, identities and times
 * aside. The fixture was captured from the product before any creating
 * path read a default, and is compared, never regenerated, here.
 */
const FIXTURE = path.join(process.cwd(), "src/lib/settings/fixtures/creation-baseline.json");
const root = process.env.DEZFIL_DATA_DIR!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(root, "creation-baseline-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
});
afterEach(async () => {
  await retirementsSettled(); closeMetadataDb(); resetQueryInstance();
  vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});

it("stores a new map, its points, lines and areas layers and a sketch as before", async () => {
  const before = JSON.parse(await readFile(FIXTURE, "utf8"));
  // What the comparison rests on is in the fixture: four layers, and a map
  // that stores no basemap and no legend corner, so it keeps reading Auto
  // and each surface's own fallback corner.
  expect(before.stored.layers.map((layer: { name: string }) => layer.name)).toEqual(["Points", "Lines", "Areas", "Sketch"]);
  expect(before.stored.map).toMatchObject({ basemap: null, legend_corner: null, view_lat: 40, view_lng: 0, view_zoom: 1.3 });
  expect(JSON.parse(await creationBaseline())).toEqual(before);
}, 60_000);

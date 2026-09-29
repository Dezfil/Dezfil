import { testAccountScope, testAccountRequest } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { GET } from "./route";

let dir: string;
let mapId: string;
let layerId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "w.csv");
  await writeFile(src, "name,secret,riders,lon,lat\na,s1,10,1,2\nb,s2,20,3,4\n");
  await ingestFile(testAccountScope(), src, "w.csv");
  const map = createMap(testAccountScope(), "m");
  mapId = map.id;
  const layer = await createLayer(testAccountScope(), map.id, { name: "l", sql: "SELECT * FROM w" });
  layerId = layer.id;
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function statement() {
  return GET(testAccountRequest(new Request(`http://localhost/api/maps/${mapId}/published-fields`)), {
    params: Promise.resolve({ id: mapId }),
  });
}

describe("published-fields statement route", () => {
  it("states the effective set per layer, matching what the wire carries", async () => {
    await updateLayer(testAccountScope(), layerId, { tooltip: ["name"], popup: [] });
    const res = await statement();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      layers: {
        layerId: string;
        mode: string;
        fields: { name: string; required: boolean }[];
        available: string[];
      }[];
    };
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0].mode).toBe("derived");
    expect(body.layers[0].fields).toEqual([{ name: "name", required: false }]);
    expect(body.layers[0].available).toContain("secret");
  });

  it("states list mode under an override", async () => {
    await updateLayer(testAccountScope(), layerId, { publishedFields: ["riders"] });
    const res = await statement();
    const body = await res.json();
    expect(body.layers[0].mode).toBe("list");
    expect(body.layers[0].fields).toEqual([{ name: "riders", required: false }]);
  });

  it("states that a hidden layer shares nothing (round one)", async () => {
    await updateLayer(testAccountScope(), layerId, { visible: false });
    const res = await statement();
    const body = await res.json();
    expect(body.layers[0]).toMatchObject({
      layerId,
      hidden: true,
      fields: [],
    });
    expect(body.layers[0].available).toBeUndefined();
  });

  it("degrades per layer when a layer's SQL cannot resolve", async () => {
    await createLayer(testAccountScope(), mapId, { name: "ok", sql: "SELECT * FROM w" });
    // Break the first layer underneath (bypassing validation) by pointing
    // it at a name that no longer resolves.
    const { updateLayerFields } = await import("@/lib/metadata/maps");
    updateLayerFields(layerId, { sql: "SELECT * FROM vanished" });
    const res = await statement();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layers).toHaveLength(2);
    expect(body.layers[0].error).toBeTruthy();
    expect(body.layers[0].fields).toBeUndefined();
    expect(body.layers[1].fields).toBeDefined();
  });
});

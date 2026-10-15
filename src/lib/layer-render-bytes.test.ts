import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, updateLayer, type LayerRenderData } from "@/lib/layer-service";
import type { Layer } from "@/lib/metadata/maps";

/**
 * Bytes drawn per layer on the layer render: the complete answer, envelope
 * included, is admitted at the configured value and refused one byte under
 * it with the errored-layer envelope; a single value has no ceiling of its
 * own.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  await rm(dir, { recursive: true, force: true });
});

/** Icons draw inline only: the tile road never takes them. */
async function iconLayer(sql: string): Promise<Layer> {
  const map = createMap(testAccountScope(), "bytes");
  const layer = await createLayer(testAccountScope(), map.id, { name: "Icons", sql },
    { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  return updateLayer(testAccountScope(), layer.id, { viz: { type: "icon", glyph: "marker" } },
    { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
}

const render = (layer: Layer): Promise<LayerRenderData> =>
  renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), layer.id) });

describe("Bytes drawn per layer", () => {
  it("admits the complete answer at its size and refuses it one byte over", async () => {
    const layer = await iconLayer(`SELECT ST_Point(i * 0.5, -i) AS geometry, i AS id, repeat('é"', i) AS label,
      {'nested': [i, NULL]} AS detail FROM range(40) t(i)`);
    const whole = await render(layer);
    expect(whole).toMatchObject({ ok: true, mode: "inline", featureCount: 40 });
    const bytes = Buffer.byteLength(JSON.stringify(whole), "utf8");

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytes);
    expect(JSON.stringify(await render(layer))).toBe(JSON.stringify(whole));

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytes - 1);
    expect(await render(layer)).toEqual({
      layerId: layer.id,
      ok: false,
      error: {
        code: "render_bytes_exceeded",
        message: `This layer's answer is larger than ${(bytes - 1).toLocaleString("en-US")} bytes, the limit for one layer drawn in the map. Filter or aggregate it, or raise DEZFIL_RENDER_CAP_BYTES and restart.`,
      },
    });
  });

  it("refuses a result over the limit below the feature cap", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "65536";
    const layer = await iconLayer(`SELECT ST_Point(0, 0) AS geometry, repeat('x', 1024) AS payload FROM range(100)`);
    expect((await render(layer)).error?.code).toBe("render_bytes_exceeded");
  });

  it("draws a value larger than a result cell may be", async () => {
    const layer = await iconLayer(`SELECT ST_Point(0, 0) AS geometry, repeat('x', 3 * 1024 * 1024) AS payload`);
    const drawn = await render(layer);
    expect(drawn.ok).toBe(true);
    const [feature] = (drawn.geojson as { features: { properties: { payload: string } }[] }).features;
    expect(feature.properties.payload).toHaveLength(3 * 1024 * 1024);
  });
});

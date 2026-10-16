import { readDocumentRevision } from "@/lib/metadata/revisions";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection } from "@duckdb/node-api";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, updateLayer, type LayerRenderData } from "@/lib/layer-service";
import { getPublishedView, publishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";
import { resetTileArchives } from "@/lib/tiles/serve";
import type { Layer } from "@/lib/metadata/maps";

/**
 * A layer over Bytes drawn per layer reads its answer up to the limit
 * before it learns it must take its road. The builder asks for a tiled
 * layer's render every few seconds while its tiles build, and every reload
 * asks again, so the answer for the same query, filters, carried fields and
 * data is read again each time unless its outcome is remembered. These
 * tests count the inline reads each render starts.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  resetTileArchives();
  resetPublishCache();
  const rows = ["id,kind,payload,lon,lat"];
  for (let i = 0; i < 40; i++) {
    rows.push(`${i},k${i % 4},${"x".repeat(100)},${13.3 + (i % 8) * 0.02},${52.4 + Math.floor(i / 8) * 0.02}`);
  }
  const src = path.join(dir, "points.csv");
  await writeFile(src, rows.join("\n"));
  await ingestFile(testAccountScope(), src, "points.csv");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tileBuildsSettled();
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  resetTileArchives();
  resetPublishCache();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  await rm(dir, { recursive: true, force: true });
});

const revision = (mapId: string) => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });

async function layerOn(fields: Partial<Pick<Layer, "viz" | "filters" | "tooltip" | "popup" | "sql">> = {}): Promise<Layer> {
  const map = createMap(testAccountScope(), "m");
  const layer = await createLayer(testAccountScope(), map.id, { name: "Points", sql: "SELECT id, kind, payload, geometry FROM points" }, revision(map.id));
  return Object.keys(fields).length ? updateLayer(testAccountScope(), layer.id, fields, revision(map.id)) : layer;
}

const render = (layer: Layer): Promise<LayerRenderData> =>
  renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), layer.id) });
const bytesOf = (answer: LayerRenderData) => Buffer.byteLength(JSON.stringify(answer), "utf8");

/** Counts the inline answer reads (the streamed row reads a layer answer
 * is built from) each call starts. */
function inlineReads() {
  const stream = DuckDBConnection.prototype.stream;
  let reads = 0;
  vi.spyOn(DuckDBConnection.prototype, "stream").mockImplementation(function (this: DuckDBConnection, sql: string, ...rest: unknown[]) {
    if (sql.includes("__dezfil_render_rows")) reads++;
    return (stream as (...args: unknown[]) => ReturnType<typeof stream>).call(this, sql, ...rest);
  });
  return async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    const before = reads;
    const value = await work();
    return [value, reads - before];
  };
}

describe("a layer over the byte limit", () => {
  it("reads its answer once while its tiles build and once they are ready, not on every ask", async () => {
    const layer = await layerOn();
    const whole = await render(layer);
    expect(whole).toMatchObject({ ok: true, mode: "inline", featureCount: 40 });
    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    const count = inlineReads();

    const [preparing, first] = await count(() => render(layer));
    expect(preparing).toMatchObject({ ok: true, mode: "tiled", tiles: { state: "building" } });
    expect(first).toBe(1);
    // The builder's poll while the tiles build, then the reload once ready.
    const [polled, second] = await count(() => render(layer));
    expect(polled.mode).toBe("tiled");
    await tileBuildsSettled();
    const [ready, third] = await count(() => render(layer));
    expect(ready).toMatchObject({ ok: true, mode: "tiled", tiles: { state: "ready" } });
    expect([second, third]).toEqual([0, 0]);
  });

  it("answers the same refusal without reading again for a layer that cannot be tiled", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    const layer = await layerOn({ viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: "id" } });
    const count = inlineReads();
    const [refused, first] = await count(() => render(layer));
    expect(refused.error?.code).toBe("render_bytes_exceeded");
    const [again, second] = await count(() => render(layer));
    expect(again).toEqual(refused);
    expect([first, second]).toEqual([1, 0]);
  });

  it("reads again when the answer could have changed: the data, the query, the fields carried or the limit", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    let layer = await layerOn({ viz: { type: "cluster", radiusPx: 64, color: "fixed", showCounts: true }, tooltip: [], popup: [] });
    const count = inlineReads();
    expect((await count(() => render(layer)))[1]).toBe(1);
    expect((await count(() => render(layer)))[1]).toBe(0);

    // A raised limit is a new question; this answer now fits.
    process.env.DEZFIL_RENDER_CAP_BYTES = "1048576";
    const [fits, raised] = await count(() => render(layer));
    expect(fits).toMatchObject({ ok: true, mode: "inline" });
    expect(raised).toBe(1);
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";

    // Carrying another field changes the answer.
    layer = await updateLayer(testAccountScope(), layer.id, { tooltip: ["payload"] }, revision(layer.mapId));
    expect((await count(() => render(layer)))[1]).toBe(1);
    expect((await count(() => render(layer)))[1]).toBe(0);

    // So does the query.
    layer = await updateLayer(testAccountScope(), layer.id, { sql: "SELECT id, kind, payload, geometry FROM points WHERE id < 30" }, revision(layer.mapId));
    expect((await count(() => render(layer)))[1]).toBe(1);

    // And the data: a refreshed dataset reads from a new artifact.
    const src = path.join(dir, "small.csv");
    await writeFile(src, ["id,kind,payload,lon,lat", "1,k,small,13.3,52.4"].join("\n"));
    const fresh = await ingestFile(testAccountScope(), src, "small.csv");
    metadataDb().prepare("UPDATE data_tables SET file = ? WHERE name = 'points'").run(fresh.file);
    const [changed, reread] = await count(() => render(layer));
    expect(reread).toBe(1);
    expect(changed).toMatchObject({ ok: true, mode: "inline", featureCount: 1 });
  });

  it("reads a query that reads the clock again once the refusal's lifetime has passed, not before", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    // Unchanged query, unchanged data: every row until a moment just
    // ahead, one row after it.
    const start = Date.now();
    const shrinks = start + 1500;
    const layer = await layerOn({
      viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: "id" },
      sql: `SELECT id, kind, payload, geometry FROM points WHERE id < CASE WHEN epoch_ms(now()) < ${shrinks} THEN 40 ELSE 1 END`,
    });
    // The memory's clock is controlled; the engine's is the real one.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      const count = inlineReads();
      const [refused, first] = await count(() => render(layer));
      expect(refused.error?.code).toBe("render_bytes_exceeded");
      expect(first).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, Math.max(0, shrinks - (performance.timeOrigin + performance.now())) + 100));
      // Within the lifetime the refusal still saves the read, though the
      // answer would now fit; asking again does not extend it.
      vi.setSystemTime(start + 29_999);
      const [stale, second] = await count(() => render(layer));
      expect(stale).toEqual(refused);
      expect(second).toBe(0);

      vi.setSystemTime(start + 30_000);
      const [fresh, third] = await count(() => render(layer));
      expect(fresh).toMatchObject({ ok: true, mode: "inline", featureCount: 1 });
      expect(third).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the published reader and the builder apart", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    const layer = await layerOn({ viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: "id" } });
    const { token } = publishMap(testAccountScope(), layer.mapId, {}, revision(layer.mapId));
    const count = inlineReads();
    expect((await count(() => render(layer)))[1]).toBe(1);
    const [view, published] = await count(async () => (await getPublishedView(token, Date.now()))!.layers[0].render);
    expect(view.error?.code).toBe("render_bytes_exceeded");
    expect(published).toBe(1);
    resetPublishCache();
    expect((await count(async () => (await getPublishedView(token, Date.now()))!.layers[0].render))[1]).toBe(0);
  });
});

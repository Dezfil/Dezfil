import { readDocumentRevision } from "@/lib/metadata/revisions";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, updateLayer, type LayerRenderData } from "@/lib/layer-service";
import { renderLayerWithSelections } from "@/lib/widget-service";
import { getPublishedView, publishMap, resetPublishCache, sanitizePublishedRender } from "@/lib/publish/publish-service";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";
import { resetTileArchives } from "@/lib/tiles/serve";
import { currentPublishedTile } from "@/lib/tiles/published";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerFilter } from "@/lib/viz";

/**
 * Over Bytes drawn per layer, below the feature cap, each layer takes the
 * excess road it takes over the feature cap: simple features become tiles
 * (with the missing and failing tile builder outcomes, worded for bytes), a
 * live-filtered layer applies its filters in SQL first, and anything else
 * answers the errored layer. A published reader sees the same roads, the
 * tiles under its token, and only the catalogue's sentence for a failure.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  resetTileArchives();
  const rows = ["id,kind,payload,lon,lat"];
  for (let i = 0; i < 40; i++) {
    rows.push(`${i},k${i % 4},${"x".repeat(100)},${13.3 + (i % 8) * 0.02},${52.4 + Math.floor(i / 8) * 0.02}`);
  }
  const src = path.join(dir, "points.csv");
  await writeFile(src, rows.join("\n"));
  await ingestFile(testAccountScope(), src, "points.csv");
});

afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  resetTileArchives();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_BYTES;
  delete process.env.DEZFIL_TIPPECANOE;
  await rm(dir, { recursive: true, force: true });
});

const revision = (mapId: string) => ({ expectedRevision: readDocumentRevision({ kind: "map", id: mapId })?.editRevision });

async function layerOn(fields: Partial<Pick<Layer, "viz" | "filters" | "tooltip" | "popup">> = {}): Promise<Layer> {
  const map = createMap(testAccountScope(), "m");
  const layer = await createLayer(testAccountScope(), map.id, { name: "Points", sql: "SELECT id, kind, payload, geometry FROM points" }, revision(map.id));
  return Object.keys(fields).length ? updateLayer(testAccountScope(), layer.id, fields, revision(map.id)) : layer;
}

const render = (layer: Layer): Promise<LayerRenderData> =>
  renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), layer.id) });
const bytesOf = (answer: LayerRenderData) => Buffer.byteLength(JSON.stringify(answer), "utf8");
const BYTE_WORDING = /^This layer's answer is larger than [\d,]+ bytes, the limit for one layer drawn in the map/;

describe("an ordinary tile-capable layer over the byte limit", () => {
  it("draws inline exactly at the limit and takes the tile road one byte under it", async () => {
    const layer = await layerOn();
    const whole = await render(layer);
    expect(whole).toMatchObject({ ok: true, mode: "inline", featureCount: 40 });

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole));
    expect(await render(layer)).toEqual(whole);

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(whole) - 1);
    const preparing = await render(layer);
    expect(preparing).toMatchObject({ ok: true, mode: "tiled", featureCount: 40, geometryType: "POINT", tiles: { state: "building" } });
    expect(preparing.geojson).toBeUndefined();
    await tileBuildsSettled();
    const ready = await render(layer);
    expect(ready).toMatchObject({ ok: true, mode: "tiled", tiles: { state: "ready" } });
    expect(ready.tiles?.url).toMatch(new RegExp(`^/api/layers/${layer.id}/tiles/\\{z\\}/\\{x\\}/\\{y\\}\\?v=\\d+$`));
  });

  it("names byte excess when the tile builder is missing and the count is within its cap", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    const answer = await render(await layerOn());
    expect(answer.error?.code).toBe("tiler_unavailable");
    expect(answer.error?.message).toMatch(BYTE_WORDING);
    expect(answer.error?.message).toMatch(/tippecanoe/);
    expect(answer.error?.message).not.toMatch(/render cap/);
  });

  it("answers a failing tile builder's failed build", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    const fake = path.join(dir, "fake-tippecanoe");
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tippecanoe v0.0-fake" >&2; exit 0; fi\necho "boom: simulated tiler failure" >&2\nexit 1\n', { mode: 0o755 });
    process.env.DEZFIL_TIPPECANOE = fake;
    const layer = await layerOn();
    expect((await render(layer)).tiles?.state).toBe("building");
    await tileBuildsSettled();
    const failed = await render(layer);
    expect(failed.error?.code).toBe("tile_build_failed");
    expect(failed.error?.message).toMatch(/boom/);
  });
});

describe("a layer that cannot be tiled over the byte limit", () => {
  const live: LayerFilter[] = [{ field: "id", kind: "range", min: 30, max: null }];
  const heat = { type: "heatmap", radiusPx: 30, intensity: 1, weight: "id" } as const;

  it("applies its live filters in SQL when the delegated answer cannot ship", async () => {
    const layer = await layerOn({ viz: heat, filters: live });
    const delegated = await render(layer);
    expect(delegated).toMatchObject({ ok: true, featureCount: 40, liveFiltered: true });

    process.env.DEZFIL_RENDER_CAP_BYTES = String(bytesOf(delegated) - 1);
    const settled = await render(layer);
    expect(settled).toMatchObject({ ok: true, mode: "inline", featureCount: 10 });
    expect(settled.liveFiltered).toBeUndefined();
  });

  it("answers the errored layer when even the filtered answer exceeds the limit", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "256";
    const layer = await layerOn({ viz: heat, filters: live });
    const refused = await render(layer);
    expect(refused).toMatchObject({ layerId: layer.id, ok: false, error: { code: "render_bytes_exceeded" } });
    expect(refused.error?.message).toMatch(BYTE_WORDING);
  });
});

describe("a published reader over the byte limit", () => {
  async function published(fields: Partial<Pick<Layer, "viz" | "filters" | "tooltip" | "popup">>) {
    const layer = await layerOn(fields);
    const { token } = publishMap(testAccountScope(), layer.mapId, {}, revision(layer.mapId));
    return { layer, token };
  }

  it("takes the tile road under its token in the initial view, and the tile gate serves the archive", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "1024";
    const { layer, token } = await published({});
    const first = (await getPublishedView(token, Date.now()))!.layers[0].render;
    expect(first).toMatchObject({ ok: true, mode: "tiled", featureCount: 40, tiles: { state: "building" } });
    await tileBuildsSettled();
    // Past the view's freshness window, the reader asks again.
    resetPublishCache();
    const ready = (await getPublishedView(token, Date.now()))!.layers[0].render;
    expect(ready.tiles?.url).toMatch(new RegExp(`^/api/published/${token}/tiles/${layer.id}/\\{z\\}/\\{x\\}/\\{y\\}\\?v=\\d+$`));
    expect(currentPublishedTile(token, layer.id, ready.tiles!.url!.split("?v=")[1])).not.toBeNull();
  });

  it("sees only the catalogue's sentence for a layer that cannot be tiled, initially and on a later selection", async () => {
    process.env.DEZFIL_RENDER_CAP_BYTES = "256";
    const { layer, token } = await published({
      viz: { type: "cluster", radiusPx: 64, color: "fixed", showCounts: true },
    });
    const sentence = publishedMessage("render_bytes_exceeded");
    const first = (await getPublishedView(token, Date.now()))!.layers[0].render;
    expect(first).toEqual({ layerId: layer.id, ok: false, error: { code: "render_bytes_exceeded", message: sentence } });

    const selection: LayerFilter[] = [{ field: "id", kind: "range", min: 1, max: null }];
    const context = { timeline: null, widgets: [], widgetsPublished: true };
    const later = sanitizePublishedRender(await renderLayerWithSelections(testAccountScope(), layer, selection, undefined, { published: context }));
    expect(later).toEqual({ layerId: layer.id, ok: false, error: { code: "render_bytes_exceeded", message: sentence } });
    // The builder's own selection render explains the limit to its author.
    const own = await renderLayerWithSelections(testAccountScope(), layer, selection);
    expect(own.error?.message).toMatch(BYTE_WORDING);
    expect(own.error?.message).toMatch(/DEZFIL_RENDER_CAP_BYTES/);
    expect(sentence).not.toMatch(/DEZFIL|\d/);
  });
});

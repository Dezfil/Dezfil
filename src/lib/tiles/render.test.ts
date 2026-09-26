import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { createMap } from "@/lib/map-service";
import {
  createLayer,
  renderLayer,
  requireLayer,
  updateLayer,
} from "@/lib/layer-service";
import { resetTileBuilds, tileBuildsSettled } from "./build";
import { readTile, resetTileArchives } from "./serve";

/**
 * The render decision: the render cap is a switchover, not a wall.
 * Over-cap simple features come back tiled — preparing first, then ready
 * with a tile URL — and drop back to inline the moment the effective
 * result fits again. Failure modes arrive as errored layers.
 */

let dir: string;
let layerId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  resetTileArchives();
  const rows = ["id,kind,lon,lat"];
  for (let i = 0; i < 40; i++) {
    rows.push(`${i},k${i % 4},${13.3 + (i % 8) * 0.02},${52.4 + Math.floor(i / 8) * 0.02}`);
  }
  const src = path.join(dir, "points.csv");
  await writeFile(src, rows.join("\n"));
  await ingestFile(src, "points.csv");
  const map = createMap("m");
  const layer = await createLayer(map.id, {
    name: "Points",
    sql: "SELECT id, kind, geometry FROM points",
  });
  layerId = layer.id;
});

afterEach(async () => {
  await tileBuildsSettled();
  closeMetadataDb();
  resetQueryInstance();
  resetTileBuilds();
  resetTileArchives();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  delete process.env.DEZFIL_TIPPECANOE;
  await rm(dir, { recursive: true, force: true });
});

describe("the render decision", () => {
  it("over-cap points switch to tiles: preparing, then ready with a URL", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
    const layer = requireLayer(layerId);

    const preparing = await renderLayer(layer);
    expect(preparing.ok).toBe(true);
    expect(preparing.mode).toBe("tiled");
    expect(preparing.tiles?.state).toBe("building");
    expect(preparing.featureCount).toBe(40);
    expect(preparing.geometryType).toBe("POINT");
    expect(preparing.geojson).toBeUndefined();

    await tileBuildsSettled();
    const ready = await renderLayer(layer);
    expect(ready.mode).toBe("tiled");
    expect(ready.tiles?.state).toBe("ready");
    expect(ready.geometryType).toBe("POINT");
    expect(ready.tiles?.url).toMatch(
      new RegExp(`^/api/layers/${layerId}/tiles/\\{z\\}/\\{x\\}/\\{y\\}\\?v=\\d+$`),
    );
    expect(ready.tiles?.bounds?.[0]).toBeCloseTo(13.3, 1);
    expect(ready.tiles?.maxZoom).toBeGreaterThanOrEqual(ready.tiles!.minZoom!);

    // The archive serves real MVT bytes for a covered tile.
    const z = ready.tiles!.maxZoom!;
    const x = Math.floor(((13.37 + 180) / 360) * 2 ** z);
    const lat = 52.44;
    const y = Math.floor(
      ((1 -
        Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) /
          Math.PI) /
        2) *
        2 ** z,
    );
    const tile = await readTile(layerId, z, x, y);
    expect(tile).not.toBeNull();
    expect(tile!.byteLength).toBeGreaterThan(0);
    expect(await readTile(layerId, 0, 1, 1)).toBeNull(); // out of range: empty
  });

  it("a filter under the cap returns to inline with no wait — and back", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
    const filtered = await updateLayer(layerId, {
      filters: [{ field: "kind", kind: "values", values: ["k0"] }],
    });
    const inline = await renderLayer(filtered);
    expect(inline.mode).toBe("inline");
    expect(inline.featureCount).toBe(10);
    expect(inline.geometryType).toBe("POINT");

    const unfiltered = await updateLayer(layerId, { filters: [] });
    const tiled = await renderLayer(unfiltered);
    expect(tiled.mode).toBe("tiled");
  });

  it("under-cap layers keep today's inline path untouched", async () => {
    const layer = requireLayer(layerId);
    const render = await renderLayer(layer);
    expect(render.mode).toBe("inline");
    expect(render.featureCount).toBe(40);
    expect(render.geometryType).toBe("POINT");
    expect(render.tiles).toBeUndefined();
  });

  it("a missing tiler degrades h3-style: only this layer errors", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    const render = await renderLayer(requireLayer(layerId));
    expect(render.ok).toBe(false);
    expect(render.error?.code).toBe("tiler_unavailable");
    expect(render.error?.message).toMatch(/tippecanoe/);
  });

  it("a failed build renders as an errored layer with the message", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
    // A tiler that answers the probe but fails every build.
    const fake = path.join(dir, "fake-tippecanoe");
    await writeFile(
      fake,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tippecanoe v0.0-fake" >&2; exit 0; fi\necho "boom: simulated tiler failure" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    process.env.DEZFIL_TIPPECANOE = fake;

    const preparing = await renderLayer(requireLayer(layerId));
    expect(preparing.tiles?.state).toBe("building");
    await tileBuildsSettled();

    const failed = await renderLayer(requireLayer(layerId));
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("tile_build_failed");
    expect(failed.error?.message).toMatch(/boom/);
  });
});

import { readFileSync } from "node:fs";
import { tileArchivePath, tileScratchDir } from "./paths";
import { tileEvidencePath } from "./evidence";
import { getTileRecord } from "@/lib/metadata/tiles";
const storage = vi.hoisted(() => ({ full: false, failCommit: false, swapped: false, previous: Buffer.alloc(0) }));
vi.mock("@/lib/system/storage-state", async original => {
  const real = await original<typeof import("@/lib/system/storage-state")>();
  return { ...real, readStorageState: () => storage.full ? { full: true, free: 0, total: 2 ** 30, threshold: real.STORAGE_FULL_BYTES } : real.readStorageState() };
});
vi.mock("@/lib/metadata/tiles", async original => {
  const real = await original<typeof import("@/lib/metadata/tiles")>();
  return { ...real, upsertTileRecord: (...args: Parameters<typeof real.upsertTileRecord>) => {
    if (storage.failCommit && args[0].state === "ready") {
      storage.swapped = !readFileSync(tileArchivePath(args[0].layerId)).equals(storage.previous);
      storage.full = true;
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    }
    return real.upsertTileRecord(...args);
  } };
});
import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
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
  storage.full = storage.failCommit = storage.swapped = false;
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
  await ingestFile(testAccountScope(), src, "points.csv");
  const map = createMap(testAccountScope(), "m");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "Points",
    sql: "SELECT id, kind, geometry FROM points",
  }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  layerId = layer.id;
});

afterEach(async () => {
  storage.full = storage.failCommit = false;
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
    const layer = requireLayer(testAccountScope(), layerId);

    const preparing = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    expect(preparing.ok).toBe(true);
    expect(preparing.mode).toBe("tiled");
    expect(preparing.tiles?.state).toBe("building");
    expect(preparing.featureCount).toBe(40);
    expect(preparing.geometryType).toBe("POINT");
    expect(preparing.geojson).toBeUndefined();

    await tileBuildsSettled();
    const ready = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
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
    const filtered = await updateLayer(testAccountScope(), layerId, {
      filters: [{ field: "kind", kind: "values", values: ["k0"] }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    const inline = await renderLayer(testAccountScope(), filtered, undefined, { tileAccess: privateTileAccess(testAccountScope(), (filtered).id) });
    expect(inline.mode).toBe("inline");
    expect(inline.featureCount).toBe(10);
    expect(inline.geometryType).toBe("POINT");

    const unfiltered = await updateLayer(testAccountScope(), layerId, { filters: [] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layerId)?.mapId ?? "missing") })?.editRevision });
    const tiled = await renderLayer(testAccountScope(), unfiltered, undefined, { tileAccess: privateTileAccess(testAccountScope(), (unfiltered).id) });
    expect(tiled.mode).toBe("tiled");
  });

  it("under-cap layers keep today's inline path untouched", async () => {
    const layer = requireLayer(testAccountScope(), layerId);
    const render = await renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), (layer).id) });
    expect(render.mode).toBe("inline");
    expect(render.featureCount).toBe(40);
    expect(render.geometryType).toBe("POINT");
    expect(render.tiles).toBeUndefined();
  });

  it("a missing tiler degrades h3-style: only this layer errors", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
    process.env.DEZFIL_TIPPECANOE = "/nonexistent/tippecanoe";
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layerId), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layerId)).id) });
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

    const preparing = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layerId), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layerId)).id) });
    expect(preparing.tiles?.state).toBe("building");
    await tileBuildsSettled();

    const failed = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layerId), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layerId)).id) });
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("tile_build_failed");
    expect(failed.error?.message).toMatch(/boom/);
  });
});

const render = (layer = requireLayer(testAccountScope(), layerId)) =>
  renderLayer(testAccountScope(), layer, undefined, { tileAccess: privateTileAccess(testAccountScope(), layer.id) });

it("answers storage_full initially for a new archive, keeps existing and inline renders, and retries after space returns", async () => {
  process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
  const original = requireLayer(testAccountScope(), layerId);
  await render(original); await tileBuildsSettled();
  const before = await readFile(tileArchivePath(layerId));
  storage.full = true;
  expect((await render(original)).tiles?.state).toBe("ready");
  expect((await render({ ...original, sql: original.sql + " LIMIT 1" })).mode).toBe("inline");
  const changed = { ...original, sql: original.sql + " WHERE id > 10" };
  expect(await render(changed)).toMatchObject({ ok: false, error: { code: "storage_full" } });
  expect(await readFile(tileArchivePath(layerId))).toEqual(before);
  expect(await readdir(tileScratchDir())).toEqual([]);
  storage.full = false;
  expect((await render(changed)).tiles?.state).toBe("building");
  await tileBuildsSettled();
  expect((await render(changed)).tiles?.state).toBe("ready");
});

it("restores the archive and evidence after a post-swap record failure and renders the previous bytes", async () => {
  process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
  const original = requireLayer(testAccountScope(), layerId);
  await render(original); await tileBuildsSettled();
  const before = await render(original);
  storage.previous = await readFile(tileArchivePath(layerId));
  const evidence = await readFile(tileEvidencePath(layerId));
  const record = getTileRecord(layerId);
  const z = before.tiles!.maxZoom!;
  const x = Math.floor(((13.37 + 180) / 360) * 2 ** z);
  const radians = 52.44 * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * 2 ** z);
  const tile = await readTile(layerId, z, x, y);
  expect(tile?.byteLength).toBeGreaterThan(0);
  storage.failCommit = true;
  const changed = { ...original, sql: original.sql + " WHERE id > 10" };
  await render(changed); await tileBuildsSettled();
  expect(storage.swapped).toBe(true);
  expect(await readFile(tileArchivePath(layerId))).toEqual(storage.previous);
  expect(await readFile(tileEvidencePath(layerId))).toEqual(evidence);
  expect(getTileRecord(layerId)).toEqual(record);
  expect(await render(changed)).toMatchObject({ ok: false, error: { code: "storage_exhausted" } });
  resetTileArchives();
  expect((await render(original)).tiles?.state).toBe("ready");
  expect(await readTile(layerId, z, x, y)).toEqual(tile);
  expect(await readdir(tileScratchDir())).toEqual([]);
  storage.full = storage.failCommit = false;
  expect((await render(changed)).tiles?.state).toBe("building");
  await tileBuildsSettled();
  expect((await render(changed)).tiles?.state).toBe("ready");
});

it("reports a tiler's no-space failure without sticky state or scratch", async () => {
  process.env.DEZFIL_RENDER_CAP_FEATURES = "10";
  const fake = path.join(dir, "full-tippecanoe");
  await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tippecanoe v0.0-test" >&2; exit 0; fi\necho "write: No space left on device" >&2\nexit 1\n', { mode: 0o755 });
  process.env.DEZFIL_TIPPECANOE = fake;
  expect((await render()).tiles?.state).toBe("building");
  storage.full = true;
  await tileBuildsSettled();
  expect(await render()).toMatchObject({ ok: false, error: { code: "storage_exhausted" } });
  expect(await readdir(tileScratchDir())).toEqual([]);
  storage.full = false;
  delete process.env.DEZFIL_TIPPECANOE;
  expect((await render()).tiles?.state).toBe("building");
  await tileBuildsSettled();
  expect((await render()).tiles?.state).toBe("ready");
});

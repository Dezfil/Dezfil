import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { privateTileAccess } from "@/lib/tiles/access";
import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { isValidTimeline } from "@/lib/timeline";
import {
  createMap,
  updateMap,
  requireMap,
  undoChange,
  redoChange,
} from "@/lib/map-service";
import {
  createLayer,
  updateLayer,
  renderLayer,
  requireLayer,
} from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import { defaultViz } from "@/lib/viz";
import { resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";
import { resetTileArchives } from "@/lib/tiles/serve";
import {
  publishMap,
  getPublishedView,
  resetPublishCache,
} from "@/lib/publish/publish-service";

/**
 * The docked timeline: at most one per map, pointing at an existing
 * time filter on a non-aggregated layer. The dock is recorded map state
 * (undoable); the window stays the layer's timerange filter.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  await tileBuildsSettled();
  resetTileBuilds();
  resetTileArchives();
  resetPublishCache();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_RENDER_CAP_FEATURES;
  await rm(dir, { recursive: true, force: true });
});

async function pingsTable(): Promise<void> {
  const src = path.join(dir, "pings.csv");
  await writeFile(
    src,
    [
      "name,lon,lat,seen",
      "a,13.410,52.520,2021-03-01 08:30:00",
      "b,13.402,52.523,2021-03-01 12:00:00",
      "c,13.330,52.510,2021-03-02 09:15:00",
      "d,13.360,52.480,2021-03-03 18:45:00",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "pings.csv");
}

const PINGS_SQL = "SELECT name, seen, geometry FROM pings";
const SEEN_FILTER = [
  { field: "seen", kind: "timerange" as const, min: null, max: null },
];
/** Covers the first day only — rows a and b. */
const DAY_ONE = {
  field: "seen",
  kind: "timerange" as const,
  min: "2021-03-01T00:00:00",
  max: "2021-03-01T23:59:59",
};

describe("timeline shape guard", () => {
  it("accepts a dock with and without speed, rejects malformed shapes", () => {
    expect(isValidTimeline({ layerId: "l1", field: "seen" })).toBe(true);
    expect(isValidTimeline({ layerId: "l1", field: "seen", speed: 4 })).toBe(
      true,
    );
    expect(isValidTimeline(null)).toBe(false);
    expect(isValidTimeline([])).toBe(false);
    expect(isValidTimeline({ layerId: "", field: "seen" })).toBe(false);
    expect(isValidTimeline({ layerId: "l1", field: "" })).toBe(false);
    expect(isValidTimeline({ field: "seen" })).toBe(false);
    // Speed outside the sane sweep range (or not a finite number) is refused.
    expect(isValidTimeline({ layerId: "l1", field: "seen", speed: 0 })).toBe(
      false,
    );
    expect(isValidTimeline({ layerId: "l1", field: "seen", speed: 64 })).toBe(
      false,
    );
    expect(isValidTimeline({ layerId: "l1", field: "seen", speed: NaN })).toBe(
      false,
    );
  });
});

describe("docking the timeline", () => {
  it("docks onto an existing time filter, defaults the speed, undocks via null", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    expect(map.timeline).toBeNull(); // earlier semantics: nothing docked
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: SEEN_FILTER }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(requireMap(testAccountScope(), map.id).timeline).toEqual({
      layerId: layer.id,
      field: "seen",
      speed: 1,
    });

    // An unrelated update leaves the dock alone; explicit null removes it.
    updateMap(testAccountScope(), map.id, { name: "renamed" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(requireMap(testAccountScope(), map.id).timeline).not.toBeNull();
    updateMap(testAccountScope(), map.id, { timeline: null }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(requireMap(testAccountScope(), map.id).timeline).toBeNull();
  });

  it("persists an explicit speed", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: SEEN_FILTER }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, {
      timeline: { layerId: layer.id, field: "seen", speed: 4 },
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(requireMap(testAccountScope(), map.id).timeline?.speed).toBe(4);
  });

  it("rejects unknown layers, missing filters, and aggregated layers — no partial write", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    // Not a layer of this map.
    expect(() =>
      updateMap(testAccountScope(), map.id, { timeline: { layerId: "nope", field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).toThrowError(expect.objectContaining({ code: "not_found", status: 404 }));
    // No timerange filter on that field yet.
    expect(() =>
      updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).toThrowError(/needs a time filter/);
    // A filter on a different field does not count for "seen".
    await updateLayer(testAccountScope(), layer.id, { filters: SEEN_FILTER }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(() =>
      updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "name" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).toThrowError(/needs a time filter/);
    // Aggregated layers cannot animate — cells are aggregated server-side.
    await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("hexbin") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(() =>
      updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).toThrowError(/Aggregated layers/);
    // Malformed shape.
    expect(() => updateMap(testAccountScope(), map.id, { timeline: 7 }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision })).toThrowError(
      /timeline must be/,
    );

    expect(requireMap(testAccountScope(), map.id).timeline).toBeNull();
  });

  it("dock and undock are recorded, undoable steps", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: SEEN_FILTER }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    let state = await undoChange(testAccountScope(), map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(state.timeline).toBeNull();
    state = await redoChange(testAccountScope(), map.id, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect(state.timeline).toEqual({
      layerId: layer.id,
      field: "seen",
      speed: 1,
    });
  });

  it("tolerates the docked layer going away — the map still reads, dock intact", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: SEEN_FILTER }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    // Deleting the layer does not cascade a map write (that would fight
    // undo); readers treat an unresolvable dock as no timeline.
    await removeLayer(testAccountScope(), layer.id, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    expect(requireMap(testAccountScope(), map.id).timeline?.layerId).toBe(layer.id);
  });
});

describe("the render split: docked time filter is client-side", () => {
  it("ships the time filter to the client, docked or not", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: [DAY_ONE] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    // Since every range/time filter is live: the data carries the full
    // extent and says so; the canvas windows it.
    const before = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(before.featureCount).toBe(4);
    expect(before.liveFiltered).toBe(true);

    // The dock changes playback, never the data.
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const docked = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(docked.featureCount).toBe(4);
    expect(docked.liveFiltered).toBe(true);

    updateMap(testAccountScope(), map.id, { timeline: null }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const after = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(after.featureCount).toBe(4);
  });

  it("keeps every other filter server-side while docked", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    // The day-one window would exclude c; the values filter keeps only c.
    await updateLayer(testAccountScope(), layer.id, {
      filters: [DAY_ONE, { field: "name", kind: "values", values: ["c"] }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    const docked = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    // c survives: its time filter is delegated, the values filter is not.
    expect(docked.featureCount).toBe(1);
  });

  it("falls back to server-side filtering when the layer drifts to aggregated", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: [DAY_ONE] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    // Aggregating after the dock: the dock is unresolvable, so the time
    // filter applies before aggregation again — cells reflect two rows.
    await updateLayer(testAccountScope(), layer.id, { viz: defaultViz("grid") }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(render.ok).toBe(true);
    const features = (
      render.geojson as { features: { properties: { count: number } }[] }
    ).features;
    const total = features.reduce((n, f) => n + Number(f.properties.count), 0);
    expect(total).toBe(2);
  });

  it("window changes on a docked tiled layer rebuild nothing", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "3";
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: [DAY_ONE] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    // Docked and over the cap (4 rows > 3): the tiled path, un-windowed.
    const first = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(first.mode).toBe("tiled");
    expect(first.featureCount).toBe(4);
    await tileBuildsSettled();
    const ready = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(ready.tiles?.state).toBe("ready");

    // Moving the window changes the filter but not the tile fingerprint —
    // the archive is still ready, no rebuild starts.
    await updateLayer(testAccountScope(), layer.id, {
      filters: [{ ...DAY_ONE, max: "2021-03-02T23:59:59" }],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const moved = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(moved.tiles?.state).toBe("ready");
    expect(moved.tiles?.builtAt).toBe(ready.tiles?.builtAt);

    // Undocking changes nothing: the time filter is live either way, so
    // the fingerprint — and the archive — hold steady.
    updateMap(testAccountScope(), map.id, { timeline: null }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const undocked = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(undocked.mode).toBe("tiled");
    expect(undocked.tiles?.builtAt).toBe(ready.tiles?.builtAt);
  });
});

describe("the render split, generalized: live filters", () => {
  const XY_SQL =
    "SELECT name, seen, ST_X(geometry) AS x, ST_X(geometry) + 1 AS x2, " +
    "ST_X(geometry) + 2 AS x3, ST_X(geometry) + 3 AS x4, geometry FROM pings";
  const openRange = (field: string) =>
    ({ field, kind: "range", min: null, max: null }) as const;

  it("ships a numeric range filter to the client; a values filter stays in SQL", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: XY_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    // The range would keep only c (x ≤ 13.35); the values filter keeps a+c.
    await updateLayer(testAccountScope(), layer.id, {
      filters: [
        { field: "x", kind: "range", min: null, max: 13.35 },
        { field: "name", kind: "values", values: ["a", "c"] },
      ],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    // The values filter applied (a, c); the range filter shipped instead.
    expect(render.featureCount).toBe(2);
    expect(render.liveFiltered).toBe(true);
  });

  it("keeps filters past the slots in SQL — unless the dock claims one", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: XY_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    // Four no-op ranges fill the slots; the day-one time filter overflows
    // into SQL, so it applies server-side (rows a and b).
    await updateLayer(testAccountScope(), layer.id, {
      filters: [
        openRange("x"),
        openRange("x2"),
        openRange("x3"),
        openRange("x4"),
        DAY_ONE,
      ],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const overflow = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(overflow.featureCount).toBe(2);
    expect(overflow.liveFiltered).toBe(true);

    // Docking the timeline guarantees the time filter a slot: it moves to
    // the client (full extent ships), one no-op range takes its place in
    // SQL — playback never sits on an undelegated filter.
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const docked = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(docked.featureCount).toBe(4);
  });

  it("falls back to SQL filtering when a heatmap's unfiltered result cannot ship", async () => {
    process.env.DEZFIL_RENDER_CAP_FEATURES = "3";
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, {
      viz: defaultViz("heatmap"),
      filters: [DAY_ONE],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    // Unfiltered result (4) is over the cap and a heatmap cannot tile —
    // every filter returns to SQL: correct rows, nothing live.
    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(render.ok).toBe(true);
    expect(render.mode).toBe("inline");
    expect(render.featureCount).toBe(2);
    expect(render.liveFiltered).toBeUndefined();
  });

  it("publishes the resolved live filters for the viewer to enforce", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: XY_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, {
      filters: [
        { field: "x", kind: "range", min: null, max: 13.35 },
        { field: "name", kind: "values", values: ["a", "c"] },
      ],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    const published = view?.layers.find((l) => l.id === layer.id);
    // The values filter is baked into the payload (a and c); the range
    // filter ships resolved for the viewer's GPU.
    expect(published?.render.featureCount).toBe(2);
    expect(published?.liveFilters).toHaveLength(1);
    expect(published?.liveFilters[0]).toMatchObject({
      field: "x",
      kind: "range",
    });
    expect(published?.liveFilters[0].range[1]).toBe(13.35);
  });

  it("a heatmap under the cap delegates like any other layer", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, {
      viz: defaultViz("heatmap"),
      filters: [DAY_ONE],
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });

    const render = await renderLayer(testAccountScope(), requireLayer(testAccountScope(), layer.id), undefined, { tileAccess: privateTileAccess(testAccountScope(), (requireLayer(testAccountScope(), layer.id)).id) });
    expect(render.featureCount).toBe(4);
    expect(render.liveFiltered).toBe(true);
  });
});

describe("published timeline", () => {
  it("carries the widget block and un-windowed data for the docked layer", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: [DAY_ONE] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, {
      timeline: { layerId: layer.id, field: "seen", speed: 2 },
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });

    const { token } = publishMap(testAccountScope(), map.id);
    const view = await getPublishedView(token, Date.now());
    expect(view?.timeline).toMatchObject({
      layerId: layer.id,
      field: "seen",
      speed: 2,
      window: { min: DAY_ONE.min, max: DAY_ONE.max },
      extent: { min: "2021-03-01T08:30:00", max: "2021-03-03T18:45:00" },
    });
    expect(view?.timeline?.bins.length).toBeGreaterThan(0);
    expect(view?.timeline?.bins.reduce((a, b) => a + b, 0)).toBe(4);
    // The viewer windows client-side, so the payload has the full extent.
    const published = view?.layers.find((l) => l.id === layer.id);
    expect(published?.render.featureCount).toBe(4);
  });

  it("degrades an unresolvable dock to no timeline, not an error", async () => {
    await pingsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(testAccountScope(), map.id, { name: "P", sql: PINGS_SQL }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    await updateLayer(testAccountScope(), layer.id, { filters: [DAY_ONE] }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    updateMap(testAccountScope(), map.id, { timeline: { layerId: layer.id, field: "seen" } }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const { token } = publishMap(testAccountScope(), map.id);

    // The docked layer goes away; the published page must keep rendering.
    await removeLayer(testAccountScope(), layer.id, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const view = await getPublishedView(token, Date.now());
    expect(view).not.toBeNull();
    expect(view?.timeline).toBeNull();
    // And the windowed rows land server-side for nobody — no layer, no rows.
    expect(view?.layers).toHaveLength(0);
  });
});

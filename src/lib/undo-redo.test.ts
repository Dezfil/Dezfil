import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import {
  createMap,
  updateMap,
  requireMap,
  undoChange,
  redoChange,
  mapHistory,
} from "@/lib/map-service";
import {
  createLayer,
  updateLayer,
  duplicateLayer,
  requireLayer,
} from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import {
  undoSteps,
  setHistoryCursor,
  historyAvailability,
  stableJson,
  type HistoryStep,
} from "@/lib/metadata/history";
import { listLayers } from "@/lib/metadata/maps";
import { defaultViz } from "@/lib/viz";
import { resetTileBuilds, tileBuildsSettled } from "@/lib/tiles/build";

/**
 * Recording at the service choke points: every qualifying change
 * becomes a step holding before/after images of exactly what changed,
 * as stored; no-op writes and the viewport record nothing.
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
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function stationsTable(): Promise<void> {
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    [
      "name,category,lon,lat,riders",
      "alexanderplatz,u,13.410,52.520,900",
      "hackescher,s,13.402,52.523,700",
      "zoo,u,13.330,52.510,500",
      "sudkreuz,s,13.360,52.480,120",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
}

const STATIONS_SQL = "SELECT name, category, riders, geometry FROM stations";

/** Walk the timeline newest-first without applying anything. */
function timeline(mapId: string): HistoryStep[] {
  const out: HistoryStep[] = [];
  for (;;) {
    const steps = undoSteps(mapId);
    if (steps.length === 0) break;
    out.push(...steps);
    setHistoryCursor(mapId, steps[steps.length - 1].seq - 1);
  }
  // Leave the cursor where it was — the walk is read-only for callers.
  if (out.length) setHistoryCursor(mapId, out[0].seq);
  return out;
}

describe("recording map changes", () => {
  it("records exactly the changed fields, as stored", () => {
    const map = createMap(testAccountScope(), "m");
    updateMap(map.id, { name: "Renamed", basemap: "dark" });
    const [step] = undoSteps(map.id);
    expect(step.scope).toBe("map");
    expect(step.op).toBe("update");
    expect(step.before).toEqual({ name: "m", basemap: null });
    expect(step.after).toEqual({ name: "Renamed", basemap: "dark" });
  });

  it("records stored values, not the request — a widget normalizes first", () => {
    const map = createMap(testAccountScope(), "m");
    updateMap(map.id, {
      widgets: [
        {
          id: "n1",
          type: "note",
          layerId: null,
          title: "  Sources  ",
          field: null,
          agg: "count",
          aggField: null,
          unit: null,
          note: "b",
          format: null,
          visible: true,
        },
      ],
    });
    const [step] = undoSteps(map.id);
    // The stored image carries the trimmed title, not the request's.
    expect(
      (step.after as { widgets: { title: string }[] }).widgets[0].title,
    ).toBe("Sources");
  });

  it("never records the viewport, and skips no-op writes", () => {
    const map = createMap(testAccountScope(), "m");
    updateMap(map.id, { viewport: { lng: 13.4, lat: 52.5, zoom: 10 } });
    expect(historyAvailability(map.id)).toEqual({
      canUndo: false,
      canRedo: false,
    });
    updateMap(map.id, { name: "m" }); // identical value
    expect(historyAvailability(map.id).canUndo).toBe(false);
    // Mixed write: only the recordable, actually-changed field lands.
    updateMap(map.id, {
      viewport: { lng: 0, lat: 0, zoom: 2 },
      name: "changed",
    });
    const [step] = undoSteps(map.id);
    expect(step.before).toEqual({ name: "m" });
    expect(step.after).toEqual({ name: "changed" });
  });

  it("records a reorder as the layerOrder virtual field", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const a = await createLayer(map.id, { name: "A", sql: STATIONS_SQL });
    const b = await createLayer(map.id, { name: "B", sql: STATIONS_SQL });
    updateMap(map.id, { layerOrder: [b.id, a.id] });
    const [step] = undoSteps(map.id);
    expect(step.before).toEqual({ layerOrder: [a.id, b.id] });
    expect(step.after).toEqual({ layerOrder: [b.id, a.id] });
  });
});

describe("recording layer changes", () => {
  it("records update fields as stored, and skips no-ops", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    await updateLayer(layer.id, { visible: false });
    const [step] = undoSteps(map.id);
    expect(step.scope).toBe("layer");
    expect(step.targetId).toBe(layer.id);
    expect(step.before).toEqual({ visible: true });
    expect(step.after).toEqual({ visible: false });

    const before = timeline(map.id).length;
    await updateLayer(layer.id, { visible: false }); // no-op
    expect(timeline(map.id)).toHaveLength(before);
  });

  it("a custom icon rides layer history: undo removes it, redo restores it", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4"/></svg>';
    await updateLayer(layer.id, {
      viz: { type: "icon", glyph: "marker", customSvg: svg },
    });
    await undoChange(map.id);
    expect(
      (requireLayer(layer.id).viz as { customSvg?: string }).customSvg,
    ).toBeUndefined();
    await redoChange(map.id);
    expect(
      (requireLayer(layer.id).viz as { customSvg?: string }).customSvg,
    ).toBe(svg);
  });

  it("captures coupled server-side adjustments post-normalization", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const updated = await updateLayer(layer.id, {
      viz: defaultViz("hexbin"),
    });
    const [step] = undoSteps(map.id);
    // The recorded after-image IS the stored viz — including the fill the
    // server computed as a side effect of the viz change.
    expect(step.after?.viz).toEqual(updated.viz);
    expect(step.before?.viz).toEqual({ type: "points" });
    expect(requireLayer(layer.id).viz).toEqual(updated.viz);
  });

  it("records an aggregate filter and its settled fill as one undoable image", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const aggregated = await updateLayer(layer.id, {
      viz: {
        type: "grid",
        cellKm: 1,
        aggregate: { fn: "sum", attribute: "riders" },
      },
    });
    const before = {
      filters: aggregated.filters,
      viz: aggregated.viz,
    };
    const filters = [
      { field: "category", kind: "values" as const, values: ["u"] },
    ];

    const filtered = await updateLayer(layer.id, { filters });
    const [step] = undoSteps(map.id);
    expect(Object.keys(step.before ?? {}).sort()).toEqual(["filters", "viz"]);
    expect(step.before).toEqual(before);
    expect(step.after).toEqual({ filters, viz: filtered.viz });

    await undoChange(map.id);
    expect(requireLayer(layer.id)).toMatchObject(before);
    await redoChange(map.id);
    expect(requireLayer(layer.id)).toMatchObject({
      filters,
      viz: filtered.viz,
    });

    // An equivalent filter image is a genuine no-op: it neither
    // reclassifies nor appends a classification-only history step.
    const stepsBeforeNoop = timeline(map.id).length;
    const noOp = await updateLayer(layer.id, {
      filters: [{ values: ["u"], kind: "values", field: "category" }],
    });
    expect(noOp.viz).toEqual(filtered.viz);
    expect(timeline(map.id)).toHaveLength(stepsBeforeNoop);
  });

  it("records add, duplicate, and delete as whole-layer images", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const copy = duplicateLayer(layer.id);
    await removeLayer(copy.id);

    const steps = timeline(map.id);
    expect(steps.map((s) => s.op)).toEqual(["delete", "add", "add"]);
    const [del, dup, add] = steps;
    expect(del.before?.name).toBe("Stations copy");
    expect(del.after).toBeNull();
    expect(dup.after?.id).toBe(copy.id);
    expect(dup.before).toBeNull();
    expect(add.after?.id).toBe(layer.id);
    expect((add.after?.sql as string) ?? "").toBe(STATIONS_SQL);
  });

  it("rapid sequential style updates coalesce into one step (a slider drag)", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    for (const opacity of [0.8, 0.65, 0.5, 0.4]) {
      await updateLayer(layer.id, { style: { ...layer.style, opacity } });
    }
    const steps = timeline(map.id);
    expect(steps.map((s) => s.op)).toEqual(["update", "add"]);
    const drag = steps[0];
    expect((drag.before as { style: { opacity: number } }).style.opacity).toBe(1);
    expect((drag.after as { style: { opacity: number } }).style.opacity).toBe(0.4);
  });

  it("threads the group marker into recorded steps", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    await updateLayer(layer.id, { name: "One" }, { groupId: "turn-1" });
    updateMap(map.id, { basemap: "dark" }, { groupId: "turn-1" });
    const steps = undoSteps(map.id);
    expect(steps).toHaveLength(2); // the whole group, newest first
    expect(steps.every((s) => s.groupId === "turn-1")).toBe(true);
  });
});

describe("undo and redo application", () => {
  it("reverts and re-applies an update byte-identically", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const original = stableJson(requireLayer(layer.id).style);
    const edited = await updateLayer(layer.id, {
      style: { ...layer.style, opacity: 0.4 },
    });
    const editedJson = stableJson(edited.style);

    const undone = await undoChange(map.id);
    expect(stableJson(requireLayer(layer.id).style)).toBe(original);
    expect(undone.history).toEqual({ canUndo: true, canRedo: true }); // add step below

    const redone = await redoChange(map.id);
    expect(stableJson(requireLayer(layer.id).style)).toBe(editedJson);
    expect(redone.history.canRedo).toBe(false);
  });

  it("re-applies coupled adjustments verbatim, never recomputing", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const hexed = await updateLayer(layer.id, { viz: defaultViz("hexbin") });
    const hexJson = stableJson(hexed.viz);

    await undoChange(map.id);
    expect(requireLayer(layer.id).viz).toEqual({ type: "points" });
    await redoChange(map.id);
    // The restored viz is the recorded one — including the fill computed at
    // edit time — not a fresh classification.
    expect(stableJson(requireLayer(layer.id).viz)).toBe(hexJson);
  });

  it("restores a deleted layer whole: id, ordinal, style, legend", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const a = await createLayer(map.id, { name: "A", sql: STATIONS_SQL });
    const b = await createLayer(map.id, { name: "B", sql: STATIONS_SQL });
    await updateLayer(a.id, { legendTitle: "Alpha", visible: false });
    const beforeDelete = stableJson(requireLayer(a.id));

    await removeLayer(a.id);
    expect(listLayers(map.id).map((l) => l.id)).toEqual([b.id]);

    await undoChange(map.id);
    expect(stableJson(requireLayer(a.id))).toBe(beforeDelete);
    expect(listLayers(map.id).map((l) => l.id)).toEqual([a.id, b.id]);

    await redoChange(map.id); // delete again
    expect(listLayers(map.id).map((l) => l.id)).toEqual([b.id]);
  });

  it("undoes an add by removing the layer; redo brings it back", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    await undoChange(map.id);
    expect(listLayers(map.id)).toHaveLength(0);
    await redoChange(map.id);
    expect(requireLayer(layer.id).name).toBe("Stations");
  });

  it("restores the layer order", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const a = await createLayer(map.id, { name: "A", sql: STATIONS_SQL });
    const b = await createLayer(map.id, { name: "B", sql: STATIONS_SQL });
    updateMap(map.id, { layerOrder: [b.id, a.id] });
    await undoChange(map.id);
    expect(listLayers(map.id).map((l) => l.id)).toEqual([a.id, b.id]);
    await redoChange(map.id);
    expect(listLayers(map.id).map((l) => l.id)).toEqual([b.id, a.id]);
  });

  it("undoes a grouped turn as one step, map and layer changes together", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    await updateLayer(layer.id, { name: "Renamed" }, { groupId: "turn-1" });
    updateMap(map.id, { basemap: "dark" }, { groupId: "turn-1" });

    const undone = await undoChange(map.id);
    expect(requireLayer(layer.id).name).toBe("Stations");
    expect(requireMap(map.id).basemap).toBeNull();
    // One undo consumed the whole group; the next target is the add step.
    expect(undone.history.canUndo).toBe(true);
    const [next] = undoSteps(map.id);
    expect(next.op).toBe("add");
  });

  it("a fresh edit after undo discards the redo branch", async () => {
    const map = createMap(testAccountScope(), "m");
    updateMap(map.id, { name: "One" });
    await undoChange(map.id);
    expect(mapHistory(map.id).canRedo).toBe(true);
    updateMap(map.id, { name: "Two" });
    expect(mapHistory(map.id)).toEqual({ canUndo: true, canRedo: false });
    await expect(redoChange(map.id)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("refuses cleanly when there is nothing to undo", async () => {
    const map = createMap(testAccountScope(), "m");
    await expect(undoChange(map.id)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("captures before-images against the state the write replaces, not its entry snapshot", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    // A label with an attribute forces the viz switch below to fold a
    // normalized style into its own write — the same field the fast write
    // edits while the slow one is still settling engine work.
    const labeled = await updateLayer(layer.id, {
      style: {
        ...layer.style,
        label: {
          attribute: "name",
          size: 12,
          color: { r: 0, g: 0, b: 0, a: 1 },
          haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
        },
      },
    });

    const slow = updateLayer(layer.id, { viz: defaultViz("hexbin") });
    const fast = await updateLayer(layer.id, {
      style: { ...labeled.style, opacity: 0.4 },
    });
    await slow;

    // The interleaved timeline is continuous: the slow step's before-image
    // is the state the fast write actually left, not the slow write's own
    // entry snapshot.
    const steps = timeline(map.id);
    expect(steps[0].before?.style).toEqual(steps[1].after?.style);
    expect(
      (steps[0].before as { style: { opacity: number } }).style.opacity,
    ).toBe(0.4);

    // And the fast write is not merely recorded — it survives the slow
    // commit: the slow write re-derives its coupled containers over the
    // state the fast write left, so no accepted write is lost.
    const settled = requireLayer(layer.id).style;
    expect(settled.opacity).toBe(0.4);
    expect(settled.label).toBeDefined();
    expect(settled.label?.attribute).toBeUndefined();

    // Undo walks back through states that actually existed, verbatim.
    await undoChange(map.id);
    expect(stableJson(requireLayer(layer.id).style)).toBe(
      stableJson(fast.style),
    );
    await undoChange(map.id);
    expect(stableJson(requireLayer(layer.id).style)).toBe(
      stableJson(layer.style),
    );
  });

  it("loses no accepted write across an interleaving on disjoint fields", async () => {
    await stationsTable();
    const map = createMap(testAccountScope(), "m");
    const layer = await createLayer(map.id, {
      name: "Stations",
      sql: STATIONS_SQL,
    });
    const aggregated = await updateLayer(layer.id, {
      viz: {
        type: "grid",
        cellKm: 1,
        aggregate: { fn: "sum", attribute: "riders" },
      },
    });
    const filters = [
      { field: "category", kind: "values" as const, values: ["u"] },
    ];

    // The filter write settles fills against the engine; the rename lands
    // inside that window. Field-scoped writes must keep both.
    const slow = updateLayer(layer.id, { filters });
    await updateLayer(layer.id, { name: "Renamed mid-flight" });
    await slow;

    const final = requireLayer(layer.id);
    expect(final.name).toBe("Renamed mid-flight");
    expect(final.filters).toEqual(filters);

    // Undoing the filter step keeps the rename; undoing the rename restores
    // the original — each before-image a state that actually existed.
    await undoChange(map.id);
    expect(requireLayer(layer.id)).toMatchObject({
      name: "Renamed mid-flight",
      filters: aggregated.filters,
    });
    await undoChange(map.id);
    expect(requireLayer(layer.id).name).toBe("Stations");
  });

  it("round-trips map fields", async () => {
    const map = createMap(testAccountScope(), "m");
    const note = {
      id: "n1",
      type: "note" as const,
      layerId: null,
      title: "Note",
      field: null,
      agg: "count" as const,
      aggField: null,
      unit: null,
      note: "hello",
      format: null,
      visible: true,
    };
    updateMap(map.id, { name: "Titled", widgets: [note] });
    await undoChange(map.id);
    const reverted = requireMap(map.id);
    expect(reverted.name).toBe("m");
    expect(reverted.widgets).toEqual([]);
    await redoChange(map.id);
    const reapplied = requireMap(map.id);
    expect(reapplied.name).toBe("Titled");
    expect(reapplied.widgets).toEqual([note]);
  });
});

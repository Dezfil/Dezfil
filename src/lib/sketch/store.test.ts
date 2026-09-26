import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { createProject, fileMap, tableProjectIds } from "@/lib/metadata/projects";
import { getTableByName } from "@/lib/metadata/tables";
import { getLayer, getMap, listLayers } from "@/lib/metadata/maps";
import {
  historyAvailability,
  recordStep,
  undoSteps,
} from "@/lib/metadata/history";
import { createMap, updateMap } from "@/lib/map-service";
import { retirementsSettled } from "@/lib/ingest/retire";
import {
  appendFeature,
  cascadeDeleteSketch,
  createSketch,
  deleteFeature,
  listFeatures,
  mapSketches,
  moveVertex,
} from "./store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
});

afterEach(async () => {
  await retirementsSettled();
  closeMetadataDb();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const point = {
  kind: "point",
  geometry: { type: "Point", coordinates: [13.4, 52.5] },
};
const line = {
  kind: "line",
  geometry: {
    type: "LineString",
    coordinates: [
      [13.4, 52.5],
      [13.5, 52.6],
    ],
  },
};
const square = {
  kind: "polygon",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [13.4, 52.5],
        [13.5, 52.5],
        [13.5, 52.6],
        [13.4, 52.6],
        [13.4, 52.5],
      ],
    ],
  },
};

describe("createSketch", () => {
  it("mints table and owning layer together, provenance recorded, no history", async () => {
    const map = createMap("Berlin mobility risk");
    const made = await createSketch(map.id, square);
    expect(made.table.name).toBe("berlin_mobility_risk_sketch");
    expect(made.table.source).toBe("sketch");
    expect(made.table.sourceParams).toMatchObject({
      mapId: map.id,
      mapName: "Berlin mobility risk",
      layerId: made.layerId,
    });
    expect(made.layerName).toBe("Sketch");
    const layer = getLayer(made.layerId);
    expect(layer?.sql).toBe("SELECT * FROM berlin_mobility_risk_sketch");
    expect(layer?.style.strokeWidth).toBeGreaterThan(0);
    expect(layer?.style.pointRadius).toBeGreaterThan(0);
    expect(historyAvailability(map.id)).toEqual({
      canUndo: false,
      canRedo: false,
    });
  });

  it("keeps a dotted map name whole and advances the suffix on collision", async () => {
    const map = createMap("Map v1.2");
    const first = await createSketch(map.id, point);
    expect(first.table.name).toBe("map_v1_2_sketch");
    const second = await createSketch(map.id, point);
    expect(second.table.name).toBe("map_v1_2_sketch_2");
    expect(second.layerName).toBe("Sketch 2");
  });

  it("refuses a malformed feature and leaves nothing behind", async () => {
    const map = createMap("Clean");
    await expect(
      createSketch(map.id, { kind: "polygon", geometry: point.geometry }),
    ).rejects.toMatchObject({ code: "invalid_sketch_feature" });
    expect(listLayers(map.id)).toHaveLength(0);
    expect(await mapSketches(map.id)).toHaveLength(0);
  });
});

describe("mutations", () => {
  it("appends mixed kinds into one dataset with a composite class and stable identity", async () => {
    const map = createMap("Mixed");
    const made = await createSketch(map.id, point);
    const before = getTableByName("mixed_sketch");
    await appendFeature("mixed_sketch", line);
    await appendFeature("mixed_sketch", square);
    const after = getTableByName("mixed_sketch");
    expect(after?.id).toBe(before?.id);
    expect(after?.rowCount).toBe(3);
    expect(after?.file).not.toBe(before?.file);
    expect(after?.geometryType).toContain("POINT");
    expect(after?.geometryType).toContain("LINESTRING");
    expect(after?.geometryType).toContain("POLYGON");
    expect(made.table.sourceParams?.layerId).toBeTruthy();
  });

  it("deletes exactly one row and keeps the empty dataset and layer at zero", async () => {
    const map = createMap("Del");
    const made = await createSketch(map.id, point);
    const second = await appendFeature("del_sketch", square);
    await deleteFeature("del_sketch", made.featureId);
    let features = await listFeatures("del_sketch");
    expect(features.map((f) => f.id)).toEqual([second.featureId]);
    await deleteFeature("del_sketch", second.featureId);
    features = await listFeatures("del_sketch");
    expect(features).toHaveLength(0);
    const table = getTableByName("del_sketch");
    expect(table?.rowCount).toBe(0);
    expect(table?.geometryColumn).toBe("geom");
    expect(table?.geometryType).toBeNull();
    expect((await mapSketches(map.id))[0]).toMatchObject({ rowCount: 0, counts: {} });
    expect(getLayer(made.layerId)).not.toBeNull();
    await expect(
      deleteFeature("del_sketch", "missing"),
    ).rejects.toMatchObject({ code: "feature_not_found" });
  });

  it("moves exactly one vertex, closing position included, and preserves count and kind", async () => {
    const map = createMap("Move");
    const made = await createSketch(map.id, square);
    await moveVertex("move_sketch", made.featureId, 0, [13.35, 52.45]);
    const [feature] = await listFeatures("move_sketch");
    const ring = (feature.geometry as { coordinates: [number, number][][] })
      .coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual([13.35, 52.45]);
    expect(ring[4]).toEqual([13.35, 52.45]);
    expect(feature.kind).toBe("polygon");
  });

  it("refuses vertex moves on non-polygon kinds, bad indexes and bad positions", async () => {
    const map = createMap("Refuse");
    const made = await createSketch(map.id, line);
    await expect(
      moveVertex("refuse_sketch", made.featureId, 0, [0, 0]),
    ).rejects.toMatchObject({ code: "vertex_move_refused" });
    const poly = await appendFeature("refuse_sketch", square);
    await expect(
      moveVertex("refuse_sketch", poly.featureId, 4, [0, 0]),
    ).rejects.toMatchObject({ code: "vertex_move_refused" });
    await expect(
      moveVertex("refuse_sketch", poly.featureId, 1, [200, 0]),
    ).rejects.toMatchObject({ code: "invalid_sketch_feature" });
  });

  it("serializes concurrent appends — both land, none silently lost", async () => {
    const map = createMap("Race");
    await createSketch(map.id, point);
    await Promise.all([
      appendFeature("race_sketch", line),
      appendFeature("race_sketch", square),
    ]);
    const table = getTableByName("race_sketch");
    expect(table?.rowCount).toBe(3);
    expect(await listFeatures("race_sketch")).toHaveLength(3);
  });
});

describe("cascadeDeleteSketch", () => {
  it("removes owner, dataset and artifact; purges owner steps; keeps unrelated history", async () => {
    const map = createMap("Cascade");
    const made = await createSketch(map.id, square);
    // A manual legend arrangement includes the owner: the cascade must
    // prune its slot, not leave a dead UUID stored.
    updateMap(map.id, { legendOrder: [made.layerId] });
    // A step targeting the owner (a style edit) and an unrelated one.
    recordStep({
      mapId: map.id,
      scope: "layer",
      targetId: made.layerId,
      op: "update",
      before: { name: "Sketch" },
      after: { name: "Renamed" },
      groupId: null,
    });
    recordStep({
      mapId: map.id,
      scope: "map",
      targetId: map.id,
      op: "update",
      before: { name: "Cascade" },
      after: { name: "Cascade 2" },
      groupId: null,
    });
    const table = getTableByName("cascade_sketch");
    const abs = path.join(
      process.env.DEZFIL_DATA_DIR as string,
      table?.file as string,
    );

    const result = await cascadeDeleteSketch("cascade_sketch");
    expect(result.layerId).toBe(made.layerId);
    expect(getLayer(made.layerId)).toBeNull();
    expect(getMap(map.id)?.legendOrder).toBeNull();
    expect(getTableByName("cascade_sketch")).toBeNull();
    const remaining = undoSteps(map.id);
    expect(remaining.some((s) => s.targetId === made.layerId)).toBe(false);
    expect(remaining.some((s) => s.targetId === map.id)).toBe(true);
    await retirementsSettled();
    await expect(access(abs)).rejects.toThrow();
  });

  it("refuses to cascade a non-sketch table", async () => {
    await expect(cascadeDeleteSketch("nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("work queued behind a cascade is refused and never lands in a reclaimed dataset", async () => {
    const map = createMap("Reclaim");
    await createSketch(map.id, point);
    // The cascade enters the sketch's lane first; the append resolves its
    // keyed identity NOW (the old table) but queues behind the cascade.
    // Depending on when the queued work wakes it meets either the
    // deleted table (not_found) or a reclaimed name with a fresh
    // identity (sketch_gone) — both refuse, and neither writes.
    const cascade = cascadeDeleteSketch("reclaim_sketch");
    const append = appendFeature("reclaim_sketch", square);
    // A parallel handled branch — the rejection may land before the
    // expectation below attaches, and an unhandled-rejection warning is
    // noise this test would otherwise emit.
    append.catch(() => undefined);
    await cascade;
    const again = createMap("Reclaim!");
    await createSketch(again.id, point);
    await expect(append).rejects.toSatisfy(
      (e: { status?: number }) => e.status === 404 || e.status === 409,
    );
    const reclaimed = getTableByName("reclaim_sketch");
    expect(reclaimed?.rowCount).toBe(1);
  });

  it("purges owner-referencing widget images; untouched steps survive", async () => {
    const map = createMap("Widgets");
    const made = await createSketch(map.id, square);
    recordStep({
      mapId: map.id,
      scope: "map",
      targetId: map.id,
      op: "update",
      before: { widgets: [] },
      after: { widgets: [{ id: "w1", layerId: made.layerId }] },
      groupId: null,
    });
    recordStep({
      mapId: map.id,
      scope: "map",
      targetId: map.id,
      op: "update",
      before: { name: "Widgets" },
      after: { name: "Widgets 2" },
      groupId: null,
    });
    await cascadeDeleteSketch("widgets_sketch");
    const remaining = undoSteps(map.id);
    expect(
      remaining.some((s) => JSON.stringify(s).includes(made.layerId)),
    ).toBe(false);
    expect(remaining.some((s) => s.after?.name === "Widgets 2")).toBe(true);
  });
});

describe("the sketch's project context", () => {
  it("a sketch on a filed map joins the map's project; on an unfiled map it stays unfiled", async () => {
    const filed = createMap("Filed");
    const loose = createMap("Loose");
    const p = createProject({ name: "A" });
    fileMap(filed.id, p.id);

    const onFiled = await createSketch(filed.id, point);
    expect(tableProjectIds().get(onFiled.table.id)).toEqual([p.id]);

    const onLoose = await createSketch(loose.id, point);
    expect(tableProjectIds().get(onLoose.table.id)).toBeUndefined();

    // The membership read happens at the registering commit; the map
    // record captured at call time cannot carry a project at all, so a
    // start-time capture is structurally impossible here.
    fileMap(filed.id, null);
    const afterUnfiling = await createSketch(filed.id, point);
    expect(tableProjectIds().get(afterUnfiling.table.id)).toBeUndefined();
  });
});


describe("settled sketch mutation lanes (widening)", () => {
  for (const outcome of ["success", "failure", "cascade"] as const) {
    it(`releases the retained lane after ${outcome}`, async () => {
      const map = createMap("Lane cleanup");
      const made = await createSketch(map.id, point);
      const retained: Map<unknown, unknown>[] = [];
      const original = Map.prototype.set;
      const observe = vi.spyOn(Map.prototype, "set").mockImplementation(function (
        this: Map<unknown, unknown>, key: unknown, value: unknown,
      ) {
        if (key === made.table.id && value instanceof Promise) retained.push(this);
        return original.call(this, key, value);
      });
      try {
        if (outcome === "success") await appendFeature(made.table.name, line);
        else if (outcome === "cascade") await cascadeDeleteSketch(made.table.name);
        else await expect(deleteFeature(made.table.name, "missing-feature"))
          .rejects.toMatchObject({ code: "feature_not_found" });
      } finally {
        observe.mockRestore();
      }
      // Observe a real lane; an interception that never fires cannot pass.
      expect(retained).toHaveLength(1);
      expect(retained[0].has(made.table.id), "settled lane retains its sketch id and promise").toBe(false);
    });
  }
});

import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import {
  createMap,
  mapWithLayers,
  updateMap,
  duplicateMap,
  undoChange,
  redoChange,
} from "@/lib/map-service";
import { createLayer, duplicateLayer } from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import { orderForLegend } from "@/lib/style/legend-order";

// The manual legend arrangement's durable field: stored as part of the
// map, validated as an exact permutation, pruned with a deletion,
// remapped by duplication, and recorded in history.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    "name,lon,lat,riders\na,13.4,52.5,100\nb,13.3,52.4,500\nc,13.2,52.6,900\n",
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function seedThree() {
  const map = createMap(testAccountScope(), "Legend order");
  const ids: string[] = [];
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    const layer = await createLayer(map.id, {
      name,
      sql: "SELECT * FROM stations",
    });
    ids.push(layer.id);
  }
  return { map, ids };
}

describe("orderForLegend — the one ordering decision", () => {
  const l = (id: string) => ({ id });

  it("automatic mirrors the panel: the stored bottom-up array reversed", () => {
    expect(orderForLegend([l("a"), l("b"), l("c")], null)).toEqual([
      l("c"),
      l("b"),
      l("a"),
    ]);
    expect(orderForLegend([l("a"), l("b")], [])).toEqual([l("b"), l("a")]);
  });

  it("a manual arrangement orders top-first", () => {
    expect(
      orderForLegend([l("a"), l("b"), l("c")], ["b", "a", "c"]),
    ).toEqual([l("b"), l("a"), l("c")]);
  });

  it("layers the arrangement does not know enter at the top, panel-ordered", () => {
    // d and e were added after the arrangement was written: stored
    // bottom-up [a,b,c,d,e] shows e above d in the panel.
    expect(
      orderForLegend(
        [l("a"), l("b"), l("c"), l("d"), l("e")],
        ["c", "a", "b"],
      ),
    ).toEqual([l("e"), l("d"), l("c"), l("a"), l("b")]);
  });

  it("arrangement ids that no longer resolve are ignored", () => {
    expect(
      orderForLegend([l("a"), l("b")], ["gone", "b", "a"]),
    ).toEqual([l("b"), l("a")]);
  });
});

describe("legendOrder — the stored arrangement", () => {
  it("starts automatic, stores an exact permutation, and resets to null", async () => {
    const { map, ids } = await seedThree();
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toBeNull();

    const arrangement = [ids[1], ids[2], ids[0]];
    updateMap(testAccountScope(), map.id, { legendOrder: arrangement });
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toEqual(arrangement);

    updateMap(testAccountScope(), map.id, { legendOrder: null });
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toBeNull();
  });

  it("rejects misses, strangers, doubles and junk — leaving the map unchanged", async () => {
    const { map, ids } = await seedThree();
    const stored = [ids[2], ids[0], ids[1]];
    updateMap(testAccountScope(), map.id, { legendOrder: stored });

    const rejects: unknown[] = [
      [ids[0], ids[1]], // incomplete
      [ids[0], ids[1], "not-a-layer"], // foreign
      [ids[0], ids[0], ids[1]], // duplicate (and incomplete coverage)
      [ids[0], ids[1], ids[2], ids[0]], // duplicate over-length
      "top-to-bottom", // not an array
      [ids[0], 7, ids[2]], // non-string member
    ];
    for (const bad of rejects) {
      expect(() =>
        updateMap(testAccountScope(), map.id, { legendOrder: bad }),
      ).toThrowError(/legendOrder/);
      expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toEqual(stored);
    }
  });

  it("prunes a deleted layer's slot in the same undo gesture", async () => {
    const { map, ids } = await seedThree();
    updateMap(testAccountScope(), map.id, { legendOrder: [ids[1], ids[0], ids[2]] });

    await removeLayer(ids[0]);
    const after = mapWithLayers(testAccountScope(), map.id);
    expect(after.layers.map((l) => l.id)).toEqual([ids[1], ids[2]]);
    expect(after.legendOrder).toEqual([ids[1], ids[2]]);

    // One undo restores the layer and its slot together (one group).
    await undoChange(testAccountScope(), map.id);
    const restored = mapWithLayers(testAccountScope(), map.id);
    expect(restored.layers).toHaveLength(3);
    expect(restored.legendOrder).toEqual([ids[1], ids[0], ids[2]]);
  });

  it("deleting the last arranged layer returns the map to automatic", async () => {
    const map = createMap(testAccountScope(), "Single");
    const layer = await createLayer(map.id, {
      name: "Only",
      sql: "SELECT * FROM stations",
    });
    updateMap(testAccountScope(), map.id, { legendOrder: [layer.id] });
    await removeLayer(layer.id);
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toBeNull();
  });

  it("a layer added or duplicated under a manual order takes the top, durably", async () => {
    const { map, ids } = await seedThree();
    // ids: [Alpha, Beta, Gamma] in creation order.
    const manual = [ids[1], ids[0], ids[2]];
    updateMap(testAccountScope(), map.id, { legendOrder: manual });

    // Created: stored at the front — the slot is durable, not derived
    // from the panel on each render.
    const delta = await createLayer(map.id, {
      name: "Delta",
      sql: "SELECT * FROM stations",
    });
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toEqual([delta.id, ...manual]);

    // Duplicated: same entry rule.
    const copy = duplicateLayer(delta.id);
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toEqual([
      copy.id,
      delta.id,
      ...manual,
    ]);

    // One undo removes the duplicate and its slot together.
    await undoChange(testAccountScope(), map.id);
    const after = mapWithLayers(testAccountScope(), map.id);
    expect(after.layers.some((l) => l.id === copy.id)).toBe(false);
    expect(after.legendOrder).toEqual([delta.id, ...manual]);
  });

  it("a duplicate carries the arrangement under its copied layer ids", async () => {
    const { map, ids } = await seedThree();
    updateMap(testAccountScope(), map.id, { legendOrder: [ids[2], ids[0], ids[1]] });

    const copy = duplicateMap(testAccountScope(), map.id);
    const copied = mapWithLayers(testAccountScope(), copy.id);
    const byName = new Map(copied.layers.map((l) => [l.name, l.id]));
    expect(copied.legendOrder).toEqual([
      byName.get("Gamma"),
      byName.get("Alpha"),
      byName.get("Beta"),
    ]);
  });

  it("manual moves and resets ride undo and redo", async () => {
    const { map, ids } = await seedThree();
    const arrangement = [ids[2], ids[1], ids[0]];
    // Distinct groups make distinct gestures: within one group (or the
    // 3s coalesce window) rapid same-shape writes merge by design.
    updateMap(testAccountScope(), map.id, { legendOrder: arrangement }, { groupId: "move" });

    await undoChange(testAccountScope(), map.id);
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toBeNull();
    await redoChange(testAccountScope(), map.id);
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toEqual(arrangement);

    updateMap(testAccountScope(), map.id, { legendOrder: null }, { groupId: "reset" });
    await undoChange(testAccountScope(), map.id);
    expect(mapWithLayers(testAccountScope(), map.id).legendOrder).toEqual(arrangement);
  });
});

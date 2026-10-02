import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { getLayer as readEditLayer } from "@/lib/metadata/maps";
import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import {
  createMap,
  updateMap,
  undoChange,
  redoChange,
  duplicateMap,
} from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { removeLayer } from "@/lib/layer-removal";
import {
  computeWidgetValues,
  renderLayerWithSelections,
} from "@/lib/widget-service";
import {
  publishMap,
  getPublishedView,
  resetPublishCache,
} from "@/lib/publish/publish-service";
import { ApiError } from "@/lib/api/errors";
import { getMap, updateMapFields, deleteLayer } from "@/lib/metadata/maps";
import { recordStep } from "@/lib/metadata/history";
import type { MapWidget } from "@/lib/widgets";

/**
 * Widget values against the real engine: batched computation over the
 * effective query, crossfilter self-exclusion, top-5 + Other, stable
 * histogram domains, per-layer counts, the settle-lane gate, and the
 * published toggle.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  const source = path.join(dir, "trips.csv");
  // Categories: A×4, B×3, C×2, D×2, E×1, F×1 (+ one NULL) — six distinct,
  // so the top five leave F rolling into Other and NULL dropped.
  await writeFile(
    source,
    [
      "name,cat,val,lon,lat",
      "r1,A,10,13.40,52.50",
      "r2,A,20,13.41,52.51",
      "r3,A,30,13.42,52.52",
      "r4,A,40,13.43,52.53",
      "r5,B,50,13.44,52.54",
      "r6,B,60,13.45,52.55",
      "r7,B,70,13.46,52.56",
      "r8,C,80,13.47,52.57",
      "r9,C,90,13.48,52.58",
      "r10,D,100,13.49,52.59",
      "r11,D,110,13.50,52.60",
      "r12,E,120,13.51,52.61",
      "r13,F,130,13.52,52.62",
      "r14,,140,13.53,52.63",
    ].join("\n"),
  );
  await ingestFile(testAccountScope(), source, "trips.csv");
});

afterEach(async () => {
  closeMetadataDb();
  resetQueryInstance();
  resetPublishCache();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const WIDGETS: MapWidget[] = [
  {
    id: "wf",
    type: "formula",
    layerId: "",
    title: "Avg val",
    field: "val",
    agg: "avg",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
  },
  {
    id: "wc",
    type: "category",
    layerId: "",
    title: "By cat",
    field: "cat",
    agg: "count",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
  },
  {
    id: "wh",
    type: "histogram",
    layerId: "",
    title: "Val",
    field: "val",
    agg: "count",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
  },
  {
    id: "wn",
    type: "note",
    layerId: null,
    title: "About",
    field: null,
    agg: "count",
    aggField: null,
    unit: null,
    note: "Fixture trips.",
    format: null,
    visible: true,
  },
];

async function dashboard() {
  const map = createMap(testAccountScope(), "dash");
  const layer = await createLayer(testAccountScope(), map.id, {
    name: "Trips",
    sql: "SELECT name, cat, val, geometry FROM trips",
  }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const widgets = WIDGETS.map((w) => ({
    ...w,
    layerId: w.type === "note" ? null : layer.id,
  }));
  const withWidgets = updateMap(testAccountScope(), map.id, { widgets }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  return { map: withWidgets, layer };
}

describe("widget values", () => {
  it("computes all three types over the effective query", async () => {
    const { map } = await dashboard();
    const values = await computeWidgetValues(testAccountScope(), map, map.layers, []);

    // The note is authored text — nothing computed for it.
    expect(values.widgets.map((w) => w.id)).toEqual(["wf", "wc", "wh"]);

    const formula = values.widgets.find((w) => w.id === "wf");
    // avg(10..140 step 10 over 14 rows) = 75
    expect(formula).toMatchObject({ type: "formula", value: 75, baseline: 75 });

    const category = values.widgets.find((w) => w.id === "wc");
    if (!category || !("categories" in category)) throw new Error("no category");
    expect(category.categories.map((c) => c.value)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(category.categories.map((c) => c.n)).toEqual([4, 3, 2, 2, 1]);
    // F rolls into Other; the NULL row is dropped, not a category.
    expect(category.other).toBe(1);

    const hist = values.widgets.find((w) => w.id === "wh");
    if (!hist || !("bins" in hist)) throw new Error("no histogram");
    expect(hist.domain).toEqual({ min: 10, max: 140 });
    expect(hist.bins.reduce((a, b) => a + b, 0)).toBe(14);

    expect(values.layers).toEqual([
      { layerId: map.layers[0].id, count: 14, total: 14 },
    ]);
  });

  it("computes a request draft like a stored widget, never writing", async () => {
    const { map } = await dashboard();

    // A draft carrying wf's id replaces it for this read: sum, not avg.
    const stored = map.widgets.find((w) => w.id === "wf")!;
    const over = await computeWidgetValues(testAccountScope(), map, map.layers, [], {
      ...stored,
      agg: "sum",
    });
    // sum(10..140 step 10) = 1050
    expect(over.widgets.find((w) => w.id === "wf")).toMatchObject({
      type: "formula",
      value: 1050,
    });

    // A draft under a fresh id joins the computed set as a new card.
    const added = await computeWidgetValues(testAccountScope(), map, map.layers, [], {
      ...stored,
      id: "widget-draft-preview",
      agg: "count",
      field: null,
    });
    expect(added.widgets.map((w) => w.id)).toEqual([
      "wf",
      "wc",
      "wh",
      "widget-draft-preview",
    ]);
    expect(
      added.widgets.find((w) => w.id === "widget-draft-preview"),
    ).toMatchObject({ type: "formula", value: 14 });

    // Nothing wrote — the same read without a draft answers from the
    // stored config again.
    const plain = await computeWidgetValues(testAccountScope(), map, map.layers, []);
    expect(plain.widgets.find((w) => w.id === "wf")).toMatchObject({
      value: 75,
    });
    expect(plain.widgets.map((w) => w.id)).toEqual(["wf", "wc", "wh"]);
  });

  it("cross-filters by exclusion with self-exclusion and truthful counts", async () => {
    const { map } = await dashboard();
    // Deactivating "A": its rows leave — and so does the NULL-category
    // row, exactly as SQL's NOT IN decides.
    const values = await computeWidgetValues(testAccountScope(), map, map.layers, [
      { widgetId: "wc", kind: "exclude", values: ["A"] },
    ]);

    // The formula narrows to the remaining rows: avg(50..130) = 90 — and
    // keeps the selection-free baseline beside it.
    expect(values.widgets.find((w) => w.id === "wf")).toMatchObject({
      value: 90,
      baseline: 75,
    });

    // The category widget never filters itself: full ranking intact.
    const category = values.widgets.find((w) => w.id === "wc");
    if (!category || !("categories" in category)) throw new Error("no category");
    expect(category.categories.map((c) => c.n)).toEqual([4, 3, 2, 2, 1]);

    // The histogram is constrained — but its domain holds still.
    const hist = values.widgets.find((w) => w.id === "wh");
    if (!hist || !("bins" in hist)) throw new Error("no histogram");
    expect(hist.domain).toEqual({ min: 10, max: 140 });
    expect(hist.bins.reduce((a, b) => a + b, 0)).toBe(9);

    // The status truth: every constraint counts against the layer.
    expect(values.layers[0]).toMatchObject({ count: 9, total: 14 });
  });

  it("composes AND across widgets — a brush narrows the ranking", async () => {
    const { map } = await dashboard();
    const values = await computeWidgetValues(testAccountScope(), map, map.layers, [
      { widgetId: "wh", kind: "range", min: 45, max: null },
    ]);
    const category = values.widgets.find((w) => w.id === "wc");
    if (!category || !("categories" in category)) throw new Error("no category");
    // val >= 45 keeps B×3, C×2, D×2, E, F — A drops out entirely.
    expect(category.categories.map((c) => c.value)).not.toContain("A");
    expect(values.layers[0]).toMatchObject({ count: 10, total: 14 });
  });

  it("degrades a broken widget to a per-widget error", async () => {
    const { map } = await dashboard();
    const widgets = map.widgets.map((w) =>
      w.id === "wf" ? { ...w, field: "gone" } : w,
    );
    const patched = { ...map, widgets };
    const values = await computeWidgetValues(testAccountScope(), patched, map.layers, []);
    const formula = values.widgets.find((w) => w.id === "wf");
    expect(formula && "error" in formula).toBe(true);
    // The rest of the dashboard keeps working.
    expect(values.widgets.filter((w) => !("error" in w))).toHaveLength(2);
  });
});

describe("widget authoring", () => {
  it("validates widgets against the map's layers", async () => {
    const { map } = await dashboard();
    expect(() =>
      updateMap(testAccountScope(), map.id, {
        widgets: [{ ...WIDGETS[0], layerId: "not-a-layer" }],
      }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).toThrow(ApiError);
    expect(() => updateMap(testAccountScope(), map.id, { widgets: [{ bad: true }] }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision })).toThrow(
      ApiError,
    );
    expect(() => updateMap(testAccountScope(), map.id, { widgetsPublished: "yes" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision })).toThrow(
      ApiError,
    );
  });

  it("records history — undo removes the widget step, redo restores it", async () => {
    const { map } = await dashboard();
    const undone = await undoChange(testAccountScope(), map.id);
    expect(undone.widgets).toEqual([]);
    const redone = await redoChange(testAccountScope(), map.id);
    expect(redone.widgets.map((w) => w.id)).toEqual(["wf", "wc", "wh", "wn"]);
  });

  it("duplicating a map remaps widgets to the copied layers", async () => {
    const { map } = await dashboard();
    const copy = duplicateMap(testAccountScope(), map.id);
    expect(copy.widgets).toHaveLength(4);
    expect(copy.layers[0].id).not.toBe(map.layers[0].id);
    for (const w of copy.widgets) {
      // Data widgets follow the copied layer; the note keeps no layer.
      expect(w.layerId).toBe(w.type === "note" ? null : copy.layers[0].id);
    }
  });

  it("deleting a layer removes its widgets in the same undoable step", async () => {
    const { map, layer } = await dashboard();
    await removeLayer(testAccountScope(), layer.id, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    // The bound data widgets went with the layer; the note stays.
    expect(getMap(map.id)!.widgets.map((w) => w.id)).toEqual(["wn"]);
    // One undo gesture restores layer and widgets together.
    const undone = await undoChange(testAccountScope(), map.id);
    expect(undone.layers.map((l) => l.id)).toContain(layer.id);
    expect(undone.widgets.map((w) => w.id)).toEqual(["wf", "wc", "wh", "wn"]);
    // Redo removes both again — never an orphan in the stored row.
    const redone = await redoChange(testAccountScope(), map.id);
    expect(redone.layers.map((l) => l.id)).not.toContain(layer.id);
    expect(redone.widgets.map((w) => w.id)).toEqual(["wn"]);
  });

  it("replaying a legacy layer-only delete step cannot recreate an orphan", async () => {
    const { map, layer } = await dashboard();
    // An earlier delete recorded the layer ALONE — no widget image. Undo
    // then leaves the layer present and its widgets valid, so the v21
    // sweep finds nothing; redoing it verbatim is what would recreate
    // the orphan and brick every whole-list widget write.
    deleteLayer(layer.id);
    recordStep({
      mapId: map.id,
      scope: "layer",
      targetId: layer.id,
      op: "delete",
      before: { ...layer }, // the whole-layer image an earlier delete wrote
      after: null,
    });
    const restored = await undoChange(testAccountScope(), map.id);
    expect(restored.layers.map((l) => l.id)).toContain(layer.id);
    expect(restored.widgets).toHaveLength(4);

    const redone = await redoChange(testAccountScope(), map.id);
    expect(redone.layers.map((l) => l.id)).not.toContain(layer.id);
    // The widgets are KEPT, not swept: undoing again must restore the
    // author's configuration whole, so the replay never destroys it. They are inert on every read
    // surface.
    expect(redone.widgets).toHaveLength(4);

    // And the transient drift does not brick writes: echoing the stored
    // list back succeeds, while INTRODUCING a foreign reference is still
    // refused — the distinction that keeps the validator useful.
    expect(() =>
      updateMap(testAccountScope(), map.id, { widgets: redone.widgets }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).not.toThrow();
    expect(() =>
      updateMap(testAccountScope(), map.id, {
        widgets: [
          ...redone.widgets,
          { ...WIDGETS[1], id: "wnew", layerId: "another-dead-layer" },
        ],
      }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
    ).toThrow(ApiError);

    // Undoing the replay restores the layer, and every widget resolves
    // again — nothing was lost on the way through.
    const restoredAgain = await undoChange(testAccountScope(), map.id);
    expect(restoredAgain.layers.map((l) => l.id)).toContain(layer.id);
    expect(restoredAgain.widgets).toHaveLength(4);
  });

  it("duplication drops a data widget whose layer is gone — never a cross-map id", async () => {
    const { map } = await dashboard();
    // Plant a stored orphan through the repository, the way drift
    // reaches the row without meeting the write validator.
    updateMapFields(map.id, {
      widgets: [
        ...map.widgets,
        { ...WIDGETS[0], id: "worphan", layerId: "dead-layer" },
      ],
    });
    const copy = duplicateMap(testAccountScope(), map.id);
    // The orphan is absent; every survivor resolves inside the copy.
    expect(copy.widgets).toHaveLength(4);
    for (const w of copy.widgets) {
      expect(w.layerId).toBe(w.type === "note" ? null : copy.layers[0].id);
    }
  });
});

describe("the settle lane", () => {
  it("re-aggregates a hexbin layer under ephemeral selections, no writes", async () => {
    const { map, layer } = await dashboard();
    const hexLayer = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const full = await renderLayerWithSelections(testAccountScope(), hexLayer, []);
    const constrained = await renderLayerWithSelections(testAccountScope(), hexLayer, [
      { field: "cat", kind: "values", values: ["A"] },
    ]);
    const excluded = await renderLayerWithSelections(testAccountScope(), hexLayer, [
      { field: "cat", kind: "values", values: ["A"], exclude: true },
    ]);
    if (!full.ok || !constrained.ok || !excluded.ok) {
      throw new Error("render failed");
    }
    const count = (r: typeof full) =>
      ((r.geojson as { features: { properties: { count: number } }[] })
        .features ?? []).reduce((s, f) => s + Number(f.properties.count), 0);
    expect(count(full)).toBe(14);
    expect(count(constrained)).toBe(4);
    // Exclusion: NOT IN drops A's rows and the NULL row.
    expect(count(excluded)).toBe(9);
    expect(map.layers[0].sql).toContain("FROM trips"); // untouched
  });

  it("rejects viz types that enforce selections client-side", async () => {
    const { layer } = await dashboard();
    await expect(
      renderLayerWithSelections(testAccountScope(), layer, [
        { field: "cat", kind: "values", values: ["A"] },
      ]),
    ).rejects.toThrow(ApiError);
  });
});

describe("published selection bounding", () => {
  it("refuses a reader selection on an undeclared field, before evaluation", async () => {
    const { map, layer } = await dashboard();
    const hexLayer = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const published = {
      timeline: map.timeline,
      widgets: map.widgets,
      widgetsPublished: true,
    };
    // "name" ships in no widget and no wire column of the computed cells.
    await expect(
      renderLayerWithSelections(testAccountScope(),
        hexLayer,
        [{ field: "name", kind: "values", values: ["r1"] }],
        undefined,
        { published },
      ),
    ).rejects.toMatchObject({ code: "field_not_published" });
  });

  it("refuses a computed layer's output names — selections fold pre-aggregation (round two)", async () => {
    const { map, layer } = await dashboard();
    const hexLayer = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const published = {
      timeline: map.timeline,
      widgets: map.widgets,
      widgetsPublished: true,
    };
    // "value" and "count" name the cells' outputs, not base columns; a
    // selection folds into the base query, where they are undeclared.
    for (const field of ["value", "count"]) {
      await expect(
        renderLayerWithSelections(testAccountScope(),
          hexLayer,
          [{ field, kind: "range", min: 1, max: null }],
          undefined,
          { published },
        ),
      ).rejects.toMatchObject({ code: "field_not_published" });
    }
  });

  it("allows selections on published widget fields of computed layers", async () => {
    const { map, layer } = await dashboard();
    const hexLayer = await updateLayer(testAccountScope(), layer.id, {
      viz: { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const published = {
      timeline: map.timeline,
      widgets: map.widgets,
      widgetsPublished: true,
    };
    // "cat" is the published category widget's field — the cells no longer
    // carry it, but the published surface declares it.
    const constrained = await renderLayerWithSelections(testAccountScope(),
      hexLayer,
      [{ field: "cat", kind: "values", values: ["A"] }],
      undefined,
      { published },
    );
    if (!constrained.ok) throw new Error("render failed");
    const count = (
      constrained.geojson as { features: { properties: { count: number } }[] }
    ).features.reduce((s, f) => s + Number(f.properties.count), 0);
    expect(count).toBe(4);
  });

  it("declares wire fields too, and keeps the builder lane unbounded", async () => {
    const { map, layer } = await dashboard();
    const clustered = await updateLayer(testAccountScope(), layer.id, {
      tooltip: ["name"],
      popup: [],
      viz: { type: "cluster", radiusPx: 64, color: "fixed", showCounts: true },
    }, { expectedRevision: readEditRevision({ kind: "map", id: (readEditLayer(layer.id)?.mapId ?? "missing") })?.editRevision });
    const published = {
      timeline: map.timeline,
      widgets: [],
      widgetsPublished: true,
    };
    // A published tooltip field is on the wire — selectable.
    const byName = await renderLayerWithSelections(testAccountScope(),
      clustered,
      [{ field: "name", kind: "values", values: ["r1"] }],
      undefined,
      { published },
    );
    expect(byName.ok).toBe(true);
    // "val" is neither on the wire nor a published widget field here.
    await expect(
      renderLayerWithSelections(testAccountScope(),
        clustered,
        [{ field: "val", kind: "range", min: 100, max: null }],
        undefined,
        { published },
      ),
    ).rejects.toMatchObject({ code: "field_not_published" });
    // The builder's own settle lane stays unbounded.
    const builder = await renderLayerWithSelections(testAccountScope(), clustered, [
      { field: "val", kind: "range", min: 100, max: null },
    ]);
    expect(builder.ok).toBe(true);
  });

  it("widget-values resolves fields from stored widgets, never the wire", async () => {
    const { map } = await dashboard();
    // A smuggled `field` key on the selection must be inert: the category
    // exclusion applies to the stored widget's field (cat), never to the
    // smuggled one (val).
    const smuggled = {
      widgetId: "wc",
      kind: "exclude",
      values: ["A"],
      field: "val",
    } as unknown as import("@/lib/widgets").WidgetSelection;
    const values = await computeWidgetValues(testAccountScope(), map, map.layers, [smuggled]);
    const formula = values.widgets.find((w) => w.id === "wf");
    // Excluding cat A (and the NULL row, per NOT IN) leaves values
    // 50..130 — avg 90. Filtering by the smuggled field would leave 75.
    expect(formula).toMatchObject({ type: "formula", value: 90, baseline: 75 });
  });
});

describe("published dashboards", () => {
  it("ships visible widgets, honors the toggle, and hides drifted ones", async () => {
    const { map } = await dashboard();
    updateMap(testAccountScope(), map.id, {
      widgets: map.widgets.map((w) =>
        w.id === "wh" ? { ...w, visible: false } : w,
      ),
    }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const { token } = publishMap(testAccountScope(), map.id);

    const view = await getPublishedView(token, Date.now());
    // The note ships like any visible widget.
    expect(view?.widgets.map((w) => w.id)).toEqual(["wf", "wc", "wn"]);

    updateMap(testAccountScope(), map.id, { widgetsPublished: false }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const hidden = await getPublishedView(token, Date.now());
    expect(hidden?.widgets).toEqual([]);
  });
});

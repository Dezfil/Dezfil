import { describe, expect, it } from "vitest";
import {
  autoInteractionFields,
  hasInteraction,
  privateFieldNeeds,
  privateLayerFields,
  publishedLayerFields,
  publishedSignature,
  tileArchiveFields,
  tileArchiveSignature,
  widensPrivateFields,
  type FieldLayerConfig,
  type PublishedMapContext,
} from "@/lib/field-dependencies";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/style";
import type { MapTimeline } from "@/lib/timeline";
import { isAggregated, type LayerFilter, type LayerViz } from "@/lib/viz";
import type { MapWidget } from "@/lib/widgets";

/** Result columns with reserved names among them, so the automatic order
 * is pinned, and a drawn sketch's identity at the end. */
const COLUMNS = ["k", "__anchor", "a", "elev", "b", "c", "d", "e", "f", "g", "h", "i", "j", "feature_id", "kind"];

function widget(over: Partial<MapWidget>): MapWidget {
  return {
    id: "w1",
    type: "category",
    layerId: "layer-1",
    title: "Widget",
    field: null,
    agg: "count",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
    ...over,
  };
}

const rich: LayerStyle = {
  ...defaultStyle("POLYGON"),
  fill: { type: "categorical", attribute: "i", palette: "p", map: [], other: { r: 0, g: 0, b: 0, a: 1 } },
  strokeBy: { type: "quantile", attribute: "j", palette: "p", breaks: [], colors: [] },
  pointRadiusBy: { attribute: "h", domain: [0, 1], range: [1, 2] },
  strokeWidthBy: { attribute: "g", domain: [0, 1], range: [1, 2] },
  heightBy: { attribute: "f", domain: [0, 1], range: [1, 2] },
  label: {
    attribute: "e",
    priorityField: "d",
    size: 12,
    color: { r: 0, g: 0, b: 0, a: 1 },
    haloWidth: 1,
    haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
  },
};

const filters: LayerFilter[] = [
  { field: "c", kind: "range", min: 1, max: null },
  { field: "k", kind: "values", values: ["x"] },
  { field: "b", kind: "timerange", min: null, max: null },
];
const timeline: MapTimeline = { layerId: "layer-1", field: "b", speed: 1 };
const widgets = [
  widget({ id: "w1", field: "a" }),
  widget({ id: "w2", field: "i", layerId: "other" }),
  widget({ id: "w3", field: "h", visible: false }),
  widget({ id: "w4", field: "g", aggField: "f", agg: "sum" }),
];

const base: FieldLayerConfig = {
  id: "layer-1",
  style: defaultStyle("POINT"),
  viz: { type: "points" },
  filters: [],
  tooltip: null,
  popup: null,
  publishedFields: null,
};
const empty: PublishedMapContext = { timeline: null, widgets: [], widgetsPublished: false };

/**
 * The published field sets and signatures as they stood before the
 * policies shared their primitives with the private one. An archive's
 * fingerprint folds the signature, so any drift here would rebuild every
 * shared archive, or let a stale one read as fresh.
 */
const GOLDEN: {
  name: string;
  layer: FieldLayerConfig;
  map: PublishedMapContext;
  fields: string[];
  signature: string;
}[] = [
  {
    name: "the derived default",
    layer: base,
    map: empty,
    fields: ["k", "a", "b", "c", "d", "e", "f", "g"],
    signature: '{"override":null,"interaction":[null,null],"style":[null,null,null,null,null,null,null],"live":[],"widgets":[]}',
  },
  {
    name: "every channel, filter, dock and widget",
    layer: { ...base, style: rich, filters, tooltip: ["b", "a", "b"], popup: ["c"] },
    map: { timeline, widgets, widgetsPublished: true },
    fields: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    signature: '{"override":null,"interaction":[["a","b"],["c"]],"style":["i","j","h","g","f","e","d"],"live":["b","c"],"widgets":["a","g"]}',
  },
  {
    name: "an author override",
    layer: { ...base, style: rich, filters, tooltip: ["k"], popup: null, publishedFields: ["j", "a", "j"] },
    map: { timeline, widgets, widgetsPublished: false },
    fields: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    signature: '{"override":["a","j"],"interaction":null,"style":["i","j","h","g","f","e","d"],"live":["b","c"],"widgets":[]}',
  },
  {
    name: "a weighted heatmap",
    layer: { ...base, style: rich, viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: "j" }, tooltip: ["a"] },
    map: empty,
    fields: ["j"],
    signature: '{"override":null,"interaction":null,"style":["j"],"live":[],"widgets":[]}',
  },
  {
    name: "a cluster colored by an aggregate",
    layer: { ...base, style: rich, viz: { type: "cluster", radiusPx: 64, color: { fn: "sum", attribute: "i" }, showCounts: true }, popup: [] },
    map: empty,
    fields: ["k", "a", "b", "c", "d", "e", "f", "g", "i"],
    signature: '{"override":null,"interaction":[null,[]],"style":["i"],"live":[],"widgets":[]}',
  },
  {
    name: "an elevated hex aggregation",
    layer: {
      ...base,
      viz: { type: "hexbin", cellKm: 1.2, aggregate: { fn: "count" }, elevation: { aggregate: { fn: "count" }, height: 100 } } as LayerViz,
    },
    map: empty,
    fields: ["value", "count", "elev"],
    signature: '{"aggregated":true,"elev":true}',
  },
];

describe("the published policy and the shared tile archive", () => {
  for (const golden of GOLDEN) {
    it(`keeps ${golden.name} exactly as it was`, () => {
      expect(publishedLayerFields(golden.layer, golden.map, COLUMNS)).toEqual(golden.fields);
      expect(publishedSignature(golden.layer, golden.map)).toBe(golden.signature);
    });

    it(`builds and authorizes archives of ${golden.name} with the published set and signature`, () => {
      expect(tileArchiveFields(golden.layer, golden.map, COLUMNS)).toEqual(golden.fields);
      expect(tileArchiveSignature(golden.layer, golden.map)).toBe(golden.signature);
    });
  }
});

describe("the private policy", () => {
  const plain = COLUMNS.filter((c) => c !== "feature_id" && c !== "kind");
  const own = (layer: Partial<FieldLayerConfig>, map: Partial<PublishedMapContext> = {}, columns = plain) =>
    privateLayerFields({ ...base, ...layer }, { ...empty, ...map }, columns);

  it("carries the automatic interaction fields by the existing rule and order", () => {
    expect(own({})).toEqual(["k", "a", "b", "c", "d", "e", "f", "g"]);
    // One automatic list is enough for the rule to apply.
    expect(own({ tooltip: ["j"], popup: null })).toEqual(["k", "a", "b", "c", "d", "e", "f", "g", "j"]);
  });

  it("leaves every unused field out once interactions are explicit", () => {
    expect(own({ tooltip: [], popup: [] })).toEqual([]);
    expect(own({ tooltip: ["j"], popup: ["c"] })).toEqual(["c", "j"]);
  });

  it("follows the layer's own use, never the published override", () => {
    expect(own({ tooltip: ["b"], popup: [], publishedFields: ["j"] })).toEqual(["b"]);
    expect(own({ tooltip: ["b"], popup: [], publishedFields: [] })).toEqual(["b"]);
  });

  it("carries every style channel and label field the viz reads", () => {
    expect(own({ style: rich, tooltip: [], popup: [] })).toEqual(["d", "e", "f", "g", "h", "i", "j"]);
    expect(own({ style: rich, viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: "c" }, tooltip: ["a"] })).toEqual(["c"]);
    expect(
      own({ style: rich, viz: { type: "cluster", radiusPx: 64, color: { fn: "avg", attribute: "b" }, showCounts: true }, tooltip: [], popup: [] }),
    ).toEqual(["b"]);
  });

  it("carries the fields of the filters the canvas applies, not those applied in SQL", () => {
    const delegated: LayerFilter[] = [
      { field: "j", kind: "values", values: ["x"] },
      ...["i", "h", "g", "f", "e"].map((field): LayerFilter => ({ field, kind: "range", min: 1, max: null })),
    ];
    expect(own({ filters: delegated, tooltip: [], popup: [] })).toEqual(["f", "g", "h", "i"]);
  });

  it("carries the docked timeline's field, with or without its window filter", () => {
    expect(own({ tooltip: [], popup: [] }, { timeline })).toEqual(["b"]);
    expect(own({ tooltip: [], popup: [], filters }, { timeline })).toEqual(["b", "c"]);
    expect(own({ tooltip: [], popup: [] }, { timeline: { ...timeline, layerId: "other" } })).toEqual([]);
  });

  it("carries every widget field on the layer, shown or hidden, published or not", () => {
    expect(own({ tooltip: [], popup: [] }, { widgets, widgetsPublished: false })).toEqual(["a", "g", "h"]);
  });

  it("keeps a drawn sketch's identity with empty interaction lists", () => {
    expect(own({ tooltip: [], popup: [] }, {}, COLUMNS)).toEqual(["feature_id", "kind"]);
    // Either name alone is ordinary data.
    expect(own({ tooltip: [], popup: [] }, {}, ["kind", "a"])).toEqual([]);
  });

  it("keeps result order over reordered and computed columns", () => {
    const columns = ["total_x2", "name", "id", "share"];
    expect(own({ tooltip: ["share", "total_x2"], popup: [], style: { ...defaultStyle("POINT"), label: { ...rich.label!, attribute: "name", priorityField: null } } }, {}, columns))
      .toEqual(["total_x2", "name", "share"]);
  });

  it("carries an aggregation's computed columns", () => {
    expect(own({ viz: { type: "grid", cellKm: 5, aggregate: { fn: "count" } } })).toEqual(["value", "count"]);
  });

  it("shows the same automatic fields over the narrowed wire as over the full one", () => {
    for (const golden of GOLDEN) {
      const narrowed = privateLayerFields(golden.layer, golden.map, COLUMNS);
      const automatic = golden.layer.tooltip === null || golden.layer.popup === null;
      if (automatic && hasInteraction(golden.layer.viz) && !isAggregated(golden.layer.viz)) {
        expect(autoInteractionFields(narrowed)).toEqual(autoInteractionFields(COLUMNS));
      }
    }
  });
});

describe("what an edit adds to the private policy's needs", () => {
  const needs = (layer: Partial<FieldLayerConfig>, map: Partial<PublishedMapContext> = {}) =>
    privateFieldNeeds({ ...base, ...layer }, { ...empty, ...map });
  const widens = (before: ReturnType<typeof needs>, after: ReturnType<typeof needs>) => widensPrivateFields(before, after);
  const quiet = { tooltip: [], popup: [] };

  it("widens on a newly read field in every family", () => {
    expect(widens(needs(quiet), needs({ ...quiet, style: rich }))).toBe(true);
    expect(widens(needs({ ...quiet, style: rich }), needs({ ...quiet, style: { ...rich, label: { ...rich.label!, priorityField: "k" } } }))).toBe(true);
    expect(widens(needs(quiet), needs({ tooltip: ["a"], popup: [] }))).toBe(true);
    expect(widens(needs(quiet), needs(quiet, { widgets }))).toBe(true);
    expect(widens(needs(quiet), needs(quiet, { timeline }))).toBe(true);
    expect(widens(needs(quiet), needs({ ...quiet, filters }))).toBe(true);
  });

  it("widens when interactions turn automatic, whose fields depend on the result", () => {
    expect(widens(needs(quiet), needs({ tooltip: [], popup: null }))).toBe(true);
    expect(widens(needs({ tooltip: null, popup: [] }), needs({ tooltip: null, popup: null }))).toBe(false);
  });

  it("never widens on an edit that only drops or keeps what is read", () => {
    expect(widens(needs({ tooltip: ["a", "b"], popup: [] }), needs({ tooltip: ["a"], popup: [] }))).toBe(false);
    expect(widens(needs({ ...quiet, style: rich }), needs(quiet))).toBe(false);
    expect(widens(needs(quiet, { widgets }), needs(quiet, { widgets: widgets.map((w) => ({ ...w, title: "Renamed" })) }))).toBe(false);
    // The published override is the reader's alone.
    expect(widens(needs(quiet), needs({ ...quiet, publishedFields: ["j"] }))).toBe(false);
  });
});

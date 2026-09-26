import { describe, it, expect } from "vitest";
import {
  AUTO_TOOLTIP_FIELDS,
  autoInteractionFields,
  effectivePublishedFields,
  publishedFieldsSignature,
  publishedFieldsStatement,
  type PublishedProjectionInput,
} from "@/lib/publish/published-fields";
import { defaultStyle } from "@/lib/style/defaults";
import { defaultViz, type LayerFilter, type LayerViz } from "@/lib/viz";
import type { LayerStyle } from "@/lib/style/style";
import type { MapWidget } from "@/lib/widgets";

const COLUMNS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

function input(
  over: Partial<PublishedProjectionInput> = {},
): PublishedProjectionInput {
  return {
    layerId: "layer-1",
    style: defaultStyle("POINT"),
    viz: { type: "points" },
    filters: [],
    tooltip: null,
    popup: null,
    publishedFields: null,
    timeline: null,
    widgets: [],
    widgetsPublished: false,
    columns: COLUMNS,
    ...over,
  };
}

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

const range = (field: string): LayerFilter => ({
  field,
  kind: "range",
  min: 1,
  max: null,
});

describe("automatic interaction fields — the canvas rule, mirrored", () => {
  it("takes the first slice in result order", () => {
    expect(autoInteractionFields(COLUMNS)).toEqual(
      COLUMNS.slice(0, AUTO_TOOLTIP_FIELDS),
    );
  });

  it("strips reserved names before counting, as the canvas does", () => {
    const cols = ["a", "elev", "__anchor", "b", "c", "d", "e", "f", "g", "h"];
    expect(autoInteractionFields(cols)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
  });
});

describe("effectivePublishedFields — derived default", () => {
  it("resolves automatic tooltips to what the automatic rule shows", () => {
    expect(effectivePublishedFields(input())).toEqual(
      COLUMNS.slice(0, AUTO_TOOLTIP_FIELDS),
    );
  });

  it("uses exactly the explicit tooltip and pop-up union, no automatic", () => {
    const set = effectivePublishedFields(
      input({ tooltip: ["j"], popup: ["c"] }),
    );
    expect(set).toEqual(["c", "j"]);
  });

  it("one automatic list still resolves when the other is explicit", () => {
    const set = effectivePublishedFields(input({ tooltip: ["j"] }));
    expect(set).toEqual([...COLUMNS.slice(0, AUTO_TOOLTIP_FIELDS), "j"]);
  });

  it("includes every style-driving attribute", () => {
    const style: LayerStyle = {
      ...defaultStyle("POLYGON"),
      fill: {
        type: "categorical",
        attribute: "i",
        palette: "p",
        map: [],
        other: { r: 0, g: 0, b: 0, a: 1 },
      },
      strokeBy: {
        type: "quantile",
        attribute: "j",
        palette: "p",
        breaks: [],
        colors: [],
      },
      pointRadiusBy: { attribute: "h", domain: [0, 1], range: [1, 2] },
      strokeWidthBy: { attribute: "g", domain: [0, 1], range: [1, 2] },
      heightBy: { attribute: "f", domain: [0, 1], range: [1, 2] },
      label: {
        attribute: "e",
        size: 12,
        color: { r: 0, g: 0, b: 0, a: 1 },
        haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
      },
    };
    const set = effectivePublishedFields(
      input({ style, tooltip: [], popup: [] }),
    );
    expect(set).toEqual(["e", "f", "g", "h", "i", "j"]);
  });

  it("heatmaps derive no interaction fields — nothing to hover (round one)", () => {
    // Automatic tooltip on a heatmap resolves to nothing: the viz is not
    // pickable, so no column is "what the reader can see".
    const set = effectivePublishedFields(
      input({ viz: { ...defaultViz("heatmap"), weight: "j" } as LayerViz }),
    );
    expect(set).toEqual(["j"]);
    // An explicit tooltip list left over from another viz derives nothing
    // either; an explicit override still wins.
    expect(
      effectivePublishedFields(
        input({
          viz: { ...defaultViz("heatmap"), weight: null } as LayerViz,
          tooltip: ["a", "b"],
        }),
      ),
    ).toEqual([]);
    expect(
      effectivePublishedFields(
        input({
          viz: { ...defaultViz("heatmap"), weight: null } as LayerViz,
          publishedFields: ["c"],
        }),
      ),
    ).toEqual(["c"]);
  });

  it("stale style channels on heatmap and cluster stay off the wire (round one)", () => {
    // A layer styled as sized/categorized points, then switched: the
    // canvas ignores those channels for these viz types, so the columns
    // must not be force-published.
    const style: LayerStyle = {
      ...defaultStyle("POINT"),
      fill: {
        type: "categorical",
        attribute: "i",
        palette: "p",
        map: [],
        other: { r: 0, g: 0, b: 0, a: 1 },
      },
      pointRadiusBy: { attribute: "h", domain: [0, 1], range: [1, 2] },
    };
    expect(
      effectivePublishedFields(
        input({
          style,
          viz: { ...defaultViz("heatmap"), weight: "j" } as LayerViz,
        }),
      ),
    ).toEqual(["j"]);
    expect(
      effectivePublishedFields(
        input({
          style,
          viz: {
            type: "cluster",
            radiusPx: 64,
            color: "fixed",
            showCounts: true,
          },
          tooltip: [],
          popup: [],
        }),
      ),
    ).toEqual([]);
  });

  it("includes the heatmap weight and the cluster color aggregate", () => {
    const heat = effectivePublishedFields(
      input({
        viz: { ...defaultViz("heatmap"), weight: "j" } as LayerViz,
        tooltip: [],
        popup: [],
      }),
    );
    expect(heat).toEqual(["j"]);

    const cluster = effectivePublishedFields(
      input({
        viz: {
          type: "cluster",
          radiusPx: 64,
          color: { fn: "sum", attribute: "i" },
          showCounts: true,
        },
        tooltip: [],
        popup: [],
      }),
    );
    expect(cluster).toEqual(["i"]);
  });

  it("includes delegated live-filter fields, not server-side ones", () => {
    const filters: LayerFilter[] = [
      { field: "j", kind: "values", values: ["x"] },
      range("i"),
      range("h"),
      range("g"),
      range("f"),
      range("e"),
    ];
    const set = effectivePublishedFields(
      input({ filters, tooltip: [], popup: [] }),
    );
    // First four range filters are delegated (the slot count); the values
    // filter and the fifth range apply in SQL and stay off the wire.
    expect(set).toEqual(["f", "g", "h", "i"]);
  });

  it("includes the docked timeline field for its layer only", () => {
    const timeline = { layerId: "layer-1", field: "j", speed: 1 };
    const filters: LayerFilter[] = [
      { field: "j", kind: "timerange", min: null, max: null },
    ];
    expect(
      effectivePublishedFields(
        input({ timeline, filters, tooltip: [], popup: [] }),
      ),
    ).toEqual(["j"]);
    expect(
      effectivePublishedFields(
        input({
          timeline: { ...timeline, layerId: "other" },
          tooltip: [],
          popup: [],
        }),
      ),
    ).toEqual([]);
    // A dock whose timerange filter drifted away degrades to no timeline
    // for readers — its field is nothing a reader can use (round two).
    expect(
      effectivePublishedFields(
        input({ timeline, filters: [], tooltip: [], popup: [] }),
      ),
    ).toEqual([]);
  });

  it("signature is insensitive to list order and duplicates (round two)", () => {
    const base = input({});
    const args = (
      over: Partial<PublishedProjectionInput>,
    ): Parameters<typeof publishedFieldsSignature> => [
      {
        id: base.layerId,
        style: base.style,
        viz: base.viz,
        filters: base.filters,
        tooltip: null,
        popup: null,
        publishedFields: null,
        ...over,
      },
      {
        timeline: null,
        widgets: [],
        widgetsPublished: false,
      },
    ];
    expect(
      publishedFieldsSignature(...args({ tooltip: ["a", "b"], popup: ["c"] })),
    ).toBe(
      publishedFieldsSignature(
        ...args({ tooltip: ["b", "a", "b"], popup: ["c", "c"] }),
      ),
    );
    expect(
      publishedFieldsSignature(...args({ publishedFields: ["b", "a"] })),
    ).toBe(publishedFieldsSignature(...args({ publishedFields: ["a", "b"] })));
    // A genuinely different set still reads as a change.
    expect(
      publishedFieldsSignature(...args({ publishedFields: ["a"] })),
    ).not.toBe(publishedFieldsSignature(...args({ publishedFields: ["a", "b"] })));
  });

  it("includes published visible widget fields bound to this layer only", () => {
    const widgets = [
      widget({ id: "w1", field: "j" }),
      widget({ id: "w2", field: "i", layerId: "other" }),
      widget({ id: "w3", field: "h", visible: false }),
      widget({ id: "w4", field: "g", aggField: "f", agg: "sum" }),
    ];
    const set = effectivePublishedFields(
      input({ widgets, widgetsPublished: true, tooltip: [], popup: [] }),
    );
    // w2 reads another layer, w3 is hidden, and w4's ranking aggregation
    // field is consumed server-side — none of them reach this wire.
    expect(set).toEqual(["g", "j"]);

    expect(
      effectivePublishedFields(
        input({ widgets, widgetsPublished: false, tooltip: [], popup: [] }),
      ),
    ).toEqual([]);
  });
});

describe("effectivePublishedFields — author override", () => {
  it("is the functional core plus exactly the listed fields", () => {
    const style: LayerStyle = {
      ...defaultStyle("POINT"),
      fill: {
        type: "categorical",
        attribute: "i",
        palette: "p",
        map: [],
        other: { r: 0, g: 0, b: 0, a: 1 },
      },
    };
    const set = effectivePublishedFields(
      input({ style, publishedFields: ["b"], tooltip: ["c"], popup: null }),
    );
    // The listed field and the fill attribute ship; the tooltip entry and
    // the automatic pop-up resolve against what ships — they add nothing.
    expect(set).toEqual(["b", "i"]);
  });

  it("cannot remove a field the published map needs to render", () => {
    const style: LayerStyle = {
      ...defaultStyle("POINT"),
      pointRadiusBy: { attribute: "j", domain: [0, 1], range: [1, 2] },
    };
    expect(
      effectivePublishedFields(input({ style, publishedFields: [] })),
    ).toEqual(["j"]);
  });

  it("clearing the override restores the derived default", () => {
    expect(effectivePublishedFields(input({ publishedFields: null }))).toEqual(
      COLUMNS.slice(0, AUTO_TOOLTIP_FIELDS),
    );
  });
});

describe("publishedFieldsStatement — what the publish surface states", () => {
  const args = (base: PublishedProjectionInput) =>
    [
      {
        id: base.layerId,
        style: base.style,
        viz: base.viz,
        filters: base.filters,
        tooltip: base.tooltip,
        popup: base.popup,
        publishedFields: base.publishedFields,
      },
      {
        timeline: base.timeline,
        widgets: base.widgets,
        widgetsPublished: base.widgetsPublished,
      },
    ] as const;

  it("marks the functional core required and the rest optional", () => {
    const style: LayerStyle = {
      ...defaultStyle("POINT"),
      fill: {
        type: "categorical",
        attribute: "i",
        palette: "p",
        map: [],
        other: { r: 0, g: 0, b: 0, a: 1 },
      },
    };
    const base = input({ style, tooltip: ["a"], popup: [] });
    const statement = publishedFieldsStatement(...args(base), COLUMNS);
    expect(statement.mode).toBe("derived");
    expect(statement.available).toEqual(COLUMNS);
    expect(statement.fields).toEqual([
      { name: "a", required: false },
      { name: "i", required: true },
    ]);
  });

  it("reports list mode under an override, core still required", () => {
    const base = input({ publishedFields: ["b"] });
    const statement = publishedFieldsStatement(...args(base), COLUMNS);
    expect(statement.mode).toBe("list");
    expect(statement.fields).toEqual([{ name: "b", required: false }]);
    // The raw list ships verbatim — editors write against it, so a
    // listed-and-required field survives unrelated toggles (round one).
    expect(statement.list).toEqual(["b"]);
    expect(publishedFieldsStatement(...args(input()), COLUMNS).list).toBeNull();
  });

  it("offers nothing to add on aggregated layers", () => {
    const base = input({ viz: defaultViz("hexbin") });
    const statement = publishedFieldsStatement(...args(base), COLUMNS);
    expect(statement.available).toEqual([]);
    expect(statement.fields.every((f) => f.required)).toBe(true);
  });
});

describe("effectivePublishedFields — shape invariants", () => {
  it("preserves result-column order regardless of config order", () => {
    const set = effectivePublishedFields(
      input({ tooltip: ["j", "a", "e"], popup: ["c", "b"] }),
    );
    expect(set).toEqual(["a", "b", "c", "e", "j"]);
  });

  it("intersects with the columns that exist", () => {
    const set = effectivePublishedFields(
      input({
        tooltip: ["a", "vanished"],
        popup: [],
        publishedFields: null,
      }),
    );
    expect(set).toEqual(["a"]);
    expect(
      effectivePublishedFields(input({ publishedFields: ["ghost", "b"] })),
    ).toEqual(["b"]);
  });

  it("aggregated layers publish exactly their computed columns", () => {
    expect(
      effectivePublishedFields(input({ viz: defaultViz("hexbin") })),
    ).toEqual(["value", "count"]);
    const elevated: LayerViz = {
      ...defaultViz("grid"),
      elevation: { aggregate: { fn: "count" }, height: 3000 },
    } as LayerViz;
    expect(effectivePublishedFields(input({ viz: elevated }))).toEqual([
      "value",
      "count",
      "elev",
    ]);
  });
});

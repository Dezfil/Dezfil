import { describe, expect, it } from "vitest";
import {
  isValidWidgets,
  isValidSelections,
  selectionFilter,
  selectionFilters,
  formatWidgetNumber,
  MAX_WIDGETS,
  type MapWidget,
  type WidgetSelection,
} from "@/lib/widgets";

/** A valid widget to mutate per case. */
function formula(over: Partial<MapWidget> = {}): MapWidget {
  return {
    id: "w1",
    type: "formula",
    layerId: "l1",
    title: "Avg riders",
    field: "riders",
    agg: "avg",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
    ...over,
  };
}

function category(over: Partial<MapWidget> = {}): MapWidget {
  return {
    id: "w2",
    type: "category",
    layerId: "l1",
    title: "By district",
    field: "district",
    agg: "count",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
    ...over,
  };
}

function histogram(over: Partial<MapWidget> = {}): MapWidget {
  return {
    id: "w3",
    type: "histogram",
    layerId: "l1",
    title: "Speed",
    field: "speed",
    agg: "count",
    aggField: null,
    unit: null,
    note: null,
    format: null,
    visible: true,
    ...over,
  };
}

function note(over: Partial<MapWidget> = {}): MapWidget {
  return {
    id: "w4",
    type: "note",
    layerId: null,
    title: "About",
    field: null,
    agg: "count",
    aggField: null,
    unit: null,
    note: "GPS traces from the start2park project.",
    format: null,
    visible: true,
    ...over,
  };
}

describe("widget validation", () => {
  it("accepts the four types in their valid shapes", () => {
    expect(isValidWidgets([formula(), category(), histogram(), note()])).toBe(
      true,
    );
    // count formula carries no field; sum/avg category ranks a field.
    expect(isValidWidgets([formula({ agg: "count", field: null })])).toBe(true);
    expect(
      isValidWidgets([category({ agg: "sum", aggField: "riders" })]),
    ).toBe(true);
    // Formula presentation: unit, caption, format.
    expect(
      isValidWidgets([
        formula({ unit: "km/h", note: "median trip", format: "decimal1" }),
      ]),
    ).toBe(true);
  });

  it("rejects type-inconsistent shapes", () => {
    // A non-count formula needs a field.
    expect(isValidWidgets([formula({ field: null })])).toBe(false);
    // A count formula must not carry one.
    expect(isValidWidgets([formula({ agg: "count" })])).toBe(false);
    // Category ranking is count/sum/avg only, and sum needs its field.
    expect(isValidWidgets([category({ agg: "min" })])).toBe(false);
    expect(isValidWidgets([category({ agg: "sum" })])).toBe(false);
    // Histogram ignores aggregates and presentation — the shape is fixed.
    expect(isValidWidgets([histogram({ agg: "avg" })])).toBe(false);
    expect(isValidWidgets([histogram({ field: null })])).toBe(false);
    expect(isValidWidgets([histogram({ unit: "x" })])).toBe(false);
    // A note has no layer, no field, and needs a body.
    expect(isValidWidgets([note({ layerId: "l1" })])).toBe(false);
    expect(isValidWidgets([note({ note: null })])).toBe(false);
    expect(isValidWidgets([note({ note: "  " })])).toBe(false);
    expect(isValidWidgets([note({ field: "x" })])).toBe(false);
    // An unknown format is rejected.
    expect(
      isValidWidgets([formula({ format: "roman" as MapWidget["format"] })]),
    ).toBe(false);
  });

  it("rejects duplicates, blank titles, and the cap", () => {
    expect(isValidWidgets([formula(), formula()])).toBe(false);
    expect(isValidWidgets([formula({ title: "  " })])).toBe(false);
    expect(isValidWidgets([formula({ title: "x".repeat(61) })])).toBe(false);
    const many = Array.from({ length: MAX_WIDGETS + 1 }, (_, i) =>
      formula({ id: `w${i}` }),
    );
    expect(isValidWidgets(many)).toBe(false);
  });
});

describe("formula number formatting", () => {
  it("renders each format", () => {
    expect(formatWidgetNumber(12345, null)).toBe("12.3k");
    expect(formatWidgetNumber(12345, "compact")).toBe("12.3K");
    expect(formatWidgetNumber(0.0123, "percent")).toBe("1.2%");
    expect(formatWidgetNumber(0.0123, "percent2")).toBe("1.23%");
    expect(formatWidgetNumber(1234.56, "integer")).toBe("1,235");
    expect(formatWidgetNumber(1234.56, "decimal1")).toBe("1,234.6");
    expect(formatWidgetNumber(1234.5, "decimal2")).toBe("1,234.50");
    expect(formatWidgetNumber(null, "compact")).toBe("—");
  });
});

describe("selection validation", () => {
  it("accepts exclusion and range selections, one per widget", () => {
    expect(
      isValidSelections([
        { widgetId: "w2", kind: "exclude", values: ["Nordend"] },
        { widgetId: "w3", kind: "range", min: 7, max: null },
      ]),
    ).toBe(true);
    // An empty exclusion set is no selection at all.
    expect(
      isValidSelections([{ widgetId: "w2", kind: "exclude", values: [] }]),
    ).toBe(false);
    expect(
      isValidSelections([
        { widgetId: "w2", kind: "exclude", values: ["a"] },
        { widgetId: "w2", kind: "exclude", values: ["b"] },
      ]),
    ).toBe(false);
    expect(
      isValidSelections([{ widgetId: "w3", kind: "range", min: NaN, max: 1 }]),
    ).toBe(false);
  });
});

describe("selection → filter resolution", () => {
  const widgets = [formula(), category(), histogram(), note()];
  const sel: WidgetSelection[] = [
    { widgetId: "w2", kind: "exclude", values: ["Nordend", "Ostend"] },
    { widgetId: "w3", kind: "range", min: 7, max: 40 },
  ];

  it("resolves exclusions from the widget, never the request", () => {
    expect(selectionFilter(sel[0], category())).toEqual({
      field: "district",
      kind: "values",
      values: ["Nordend", "Ostend"],
      exclude: true,
    });
    // Kind mismatch filters nothing rather than something surprising.
    expect(selectionFilter(sel[0], histogram())).toBeNull();
    expect(selectionFilter(sel[1], category())).toBeNull();
    expect(selectionFilter(sel[1], undefined)).toBeNull();
    expect(selectionFilter(sel[0], note())).toBeNull();
  });

  it("composes AND across widgets, excluding the widget's own selection", () => {
    // The map (no exclusion) carries both constraints.
    expect(selectionFilters(sel, widgets, "l1", null)).toHaveLength(2);
    // The category widget never filters itself — only the brush applies.
    const forCategory = selectionFilters(sel, widgets, "l1", "w2");
    expect(forCategory).toEqual([
      { field: "speed", kind: "range", min: 7, max: 40 },
    ]);
    // Another layer is untouched (own-layer scope).
    expect(selectionFilters(sel, widgets, "l9", null)).toEqual([]);
  });
});

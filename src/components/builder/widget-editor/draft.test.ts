import { describe, expect, it } from "vitest";
import type { MapWidget, WidgetType } from "@/lib/widgets";
import {
  WIDGET_TYPES,
  draftOf,
  draftValid,
  emptyDraft,
  materialize,
  nextDraft,
  type Draft,
} from "./draft";

/** Every state the selector has to be offered in. */
const STATES: (WidgetType | null)[] = [null, ...WIDGET_TYPES];

const LAYER = "layer-1";

function typed(type: WidgetType): Draft {
  return nextDraft(emptyDraft(), { type }, LAYER);
}

describe("widget draft — the four types are always offerable", () => {
  it("offers all four types, in order", () => {
    expect(WIDGET_TYPES).toEqual(["formula", "category", "histogram", "note"]);
  });

  it("covers five draft states, the untyped one included", () => {
    expect(STATES).toHaveLength(5);
    expect(STATES[0]).toBeNull();
  });

  // The defect this feature fixes: Note was a one-way door. Every ordered
  // pair has to be reachable in a single patch, from every state.
  it("moves between any two types in one patch, from any state", () => {
    for (const from of STATES) {
      const start = from === null ? emptyDraft() : typed(from);
      for (const to of WIDGET_TYPES) {
        const next = nextDraft(start, { type: to }, LAYER);
        expect(next.type).toBe(to);
      }
    }
  });
});

describe("widget draft — type transitions", () => {
  it("seats a layer when a data type is chosen from untyped", () => {
    expect(typed("formula").layerId).toBe(LAYER);
  });

  it("clears the layer for a note", () => {
    expect(typed("note").layerId).toBeNull();
  });

  // The case the old UI could not reach: entering Note cleared the layer,
  // so leaving it has to seat one again — a one-layer map never renders
  // the Layer control to seat it by hand.
  it("re-seats a layer when leaving Note", () => {
    const note = typed("note");
    expect(note.layerId).toBeNull();
    expect(nextDraft(note, { type: "histogram" }, LAYER).layerId).toBe(LAYER);
  });

  it("leaves no layer to seat when the map has none", () => {
    expect(nextDraft(typed("note"), { type: "histogram" }, null).layerId)
      .toBeNull();
  });

  it("keeps the layer across a data-to-data switch", () => {
    const cat = nextDraft(typed("formula"), { layerId: "layer-2" }, LAYER);
    expect(nextDraft(cat, { type: "category" }, LAYER).layerId).toBe("layer-2");
  });

  it("resets the type-specific settings on a switch", () => {
    const formula: Draft = {
      ...typed("formula"),
      field: "riders",
      agg: "sum",
      unit: "trips",
      format: "compact",
    };
    const next = nextDraft(formula, { type: "category" }, LAYER);
    expect(next.field).toBeNull();
    expect(next.agg).toBe("count");
    expect(next.aggField).toBeNull();
    expect(next.unit).toBeNull();
    expect(next.format).toBeNull();
  });

  // Today's behavior, preserved deliberately: the note rides along between
  // data types and clears only when the Note boundary is crossed.
  it("keeps a formula's note across a data-to-data switch, clears it across Note", () => {
    const withNote: Draft = { ...typed("formula"), note: "under the number" };
    expect(nextDraft(withNote, { type: "histogram" }, LAYER).note).toBe(
      "under the number",
    );
    expect(nextDraft(withNote, { type: "note" }, LAYER).note).toBeNull();
  });

  it("clears the field when the layer changes", () => {
    const picked: Draft = { ...typed("histogram"), field: "riders" };
    expect(nextDraft(picked, { layerId: "layer-2" }, LAYER).field).toBeNull();
  });

  it("stops suggesting a title once the user has typed one", () => {
    const named = nextDraft(typed("formula"), { title: "Mine", titled: true }, LAYER);
    expect(nextDraft(named, { type: "histogram" }, LAYER).title).toBe("Mine");
    const unnamed = nextDraft(typed("formula"), { type: "note" }, LAYER);
    expect(unnamed.title).toBe("Note");
  });
});

describe("widget draft — validity", () => {
  // An untyped draft being invalid is what keeps it out of the rail's live
  // preview and off the save action.
  it("never validates an untyped draft", () => {
    expect(draftValid(emptyDraft())).toBe(false);
    expect(
      draftValid({ ...emptyDraft(), title: "Anything", titled: true }),
    ).toBe(false);
  });

  it("validates a note only with text", () => {
    const note = nextDraft(typed("note"), { note: null }, LAYER);
    expect(draftValid(note)).toBe(false);
    expect(draftValid({ ...note, note: "   " })).toBe(false);
    expect(draftValid({ ...note, note: "hello" })).toBe(true);
  });

  it("validates a count formula without a field, others with one", () => {
    const f = typed("formula");
    expect(draftValid(f)).toBe(true);
    expect(draftValid({ ...f, agg: "sum" })).toBe(false);
    expect(draftValid({ ...f, agg: "sum", field: "riders" })).toBe(true);
  });

  it("requires a group-by field for a category, and an over-field when ranked", () => {
    const c = typed("category");
    expect(draftValid(c)).toBe(false);
    const grouped = { ...c, field: "borough", title: "By borough" };
    expect(draftValid(grouped)).toBe(true);
    expect(draftValid({ ...grouped, agg: "avg" })).toBe(false);
    expect(draftValid({ ...grouped, agg: "avg", aggField: "riders" })).toBe(true);
  });

  it("requires a title within the limit", () => {
    const f = typed("formula");
    expect(draftValid({ ...f, title: "  " })).toBe(false);
    expect(draftValid({ ...f, title: "x".repeat(400) })).toBe(false);
  });

  it("requires a layer for a data widget", () => {
    expect(draftValid({ ...typed("formula"), layerId: null })).toBe(false);
  });
});

describe("widget draft — round trip", () => {
  it("opens a saved widget on its own type and keeps its visibility", () => {
    const widget: MapWidget = {
      id: "w1",
      type: "category",
      layerId: LAYER,
      title: "By borough",
      field: "borough",
      agg: "count",
      aggField: null,
      unit: null,
      note: null,
      format: null,
      visible: false,
    };
    const d = draftOf(widget);
    expect(d.type).toBe("category");
    expect(d.titled).toBe(true);
    expect(materialize(d, "w1", false)).toEqual(widget);
  });
});

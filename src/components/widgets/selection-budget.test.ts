import { describe, expect, it } from "vitest";
import { budgetSelections } from "./selection-budget";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";

// A selection past the enforcement budget is dropped — out of every
// surface — never silently truncated at the merge, and never parked to
// re-apply itself when a slot frees.

const widget = (id: string, layerId: string, field: string | null): MapWidget =>
  ({
    id,
    type: "category",
    title: id,
    layerId,
    field,
    agg: "count",
    visible: true,
  }) as unknown as MapWidget;

const sel = (widgetId: string, value = "x"): WidgetSelection => ({
  widgetId,
  kind: "exclude",
  values: [value],
});

describe("budgetSelections", () => {
  it("keeps selections that fit beside stored dims", () => {
    const { selections, droppedLayers } = budgetSelections(
      [sel("w1"), sel("w2")],
      [widget("w1", "l1", "a"), widget("w2", "l1", "b")],
      [{ id: "l1", settles: false, storedDims: 2 }],
      4,
    );
    expect(selections).toHaveLength(2);
    expect(droppedLayers).toHaveLength(0);
  });

  it("drops the selection stored filters and the timeline push out — the composition", () => {
    // Three stored dims plus a timeline dim fill the four slots; the
    // session selection no longer fits and must leave every surface.
    const { selections, droppedLayers } = budgetSelections(
      [sel("w1")],
      [widget("w1", "l1", "a")],
      [{ id: "l1", settles: false, storedDims: 4 }],
      4,
    );
    expect(selections).toHaveLength(0);
    expect(droppedLayers).toEqual(["l1"]);
  });

  it("keeps the oldest selections and drops the overflow, in arrival order", () => {
    const { selections, droppedLayers } = budgetSelections(
      [sel("w1"), sel("w2"), sel("w3")],
      [
        widget("w1", "l1", "a"),
        widget("w2", "l1", "b"),
        widget("w3", "l1", "c"),
      ],
      [{ id: "l1", settles: false, storedDims: 2 }],
      4,
    );
    expect(selections.map((s) => s.widgetId)).toEqual(["w1", "w2"]);
    expect(droppedLayers).toEqual(["l1"]);
  });

  it("never drops settle-lane selections — they take no GPU slot", () => {
    const { selections, droppedLayers } = budgetSelections(
      [sel("w1")],
      [widget("w1", "l1", "a")],
      [{ id: "l1", settles: true, storedDims: 4 }],
      4,
    );
    expect(selections).toHaveLength(1);
    expect(droppedLayers).toHaveLength(0);
  });

  it("drops selections of vanished widgets, budget aside (the rule)", () => {
    const { selections } = budgetSelections(
      [sel("gone"), sel("w1")],
      [widget("w1", "l1", "a")],
      [{ id: "l1", settles: false, storedDims: 0 }],
      4,
    );
    expect(selections.map((s) => s.widgetId)).toEqual(["w1"]);
  });

  it("drops selections of hidden widgets — a wider batch never re-admits them", () => {
    // Before the export card widened the dashboard batch, a hidden
    // widget never reached this derivation; its retained selection must
    // stay inert when the wider list includes it.
    const hidden = { ...widget("w2", "l1", "b"), visible: false } as MapWidget;
    const { selections } = budgetSelections(
      [sel("w2"), sel("w1")],
      [widget("w1", "l1", "a"), hidden],
      [{ id: "l1", settles: false, storedDims: 0 }],
      4,
    );
    expect(selections.map((s) => s.widgetId)).toEqual(["w1"]);
  });

  it("a dropped selection is gone from the budgeted list, not parked", () => {
    // The hook prunes its raw list to exactly this output, so a slot
    // freeing later cannot resurrect what the user last saw removed.
    const raw = [sel("w1")];
    const widgets = [widget("w1", "l1", "a")];
    const full = budgetSelections(
      raw,
      widgets,
      [{ id: "l1", settles: false, storedDims: 4 }],
      4,
    );
    expect(full.selections).toHaveLength(0);
    expect(full.droppedLayers).toEqual(["l1"]);
    // Re-budgeting the PRUNED list is stable: nothing returns, nothing
    // is reported dropped a second time.
    const again = budgetSelections(
      full.selections,
      widgets,
      [{ id: "l1", settles: false, storedDims: 3 }],
      4,
    );
    expect(again.selections).toHaveLength(0);
    expect(again.droppedLayers).toHaveLength(0);
  });
});

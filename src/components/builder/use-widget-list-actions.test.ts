import { describe, expect, it } from "vitest";
import type { MapWidget } from "@/lib/widgets";
import { reorderVisibleWidgets } from "./use-widget-list-actions";

const widget = (id: string): MapWidget =>
  ({ id, layerId: null, title: id } as MapWidget);

describe("visible widget reordering", () => {
  it("moves visible cards without moving a hidden widget's slot", () => {
    const a = widget("a");
    const hidden = widget("hidden");
    const b = widget("b");

    expect(
      reorderVisibleWidgets([a, hidden, b], [a, b], ["b", "a"]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["b", "hidden", "a"]);
  });
});

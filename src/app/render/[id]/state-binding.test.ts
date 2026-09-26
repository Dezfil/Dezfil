import { describe, expect, it } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { boundToSnapshot } from "./state-binding";

/** The binding's comparison: the
 * visible layers in order at the same revision; a hidden layer's edit,
 * an edit to the map's own fields, are not what the layer reads carry. */
const layer = (id: string, updatedAt: string, visible = true) => ({ id, updatedAt, visible }) as MapWithLayers["layers"][number];
const map = (...layers: MapWithLayers["layers"][number][]) => ({ layers } as MapWithLayers);

describe("boundToSnapshot", () => {
  it("agrees when every visible layer stands at the same revision", () => {
    expect(boundToSnapshot(map(layer("a", "1"), layer("b", "1", false)), map(layer("a", "1"), layer("b", "2", false)))).toBe(true);
  });
  it("disagrees on an edited visible layer, one added or removed, or a changed order", () => {
    expect(boundToSnapshot(map(layer("a", "1")), map(layer("a", "2")))).toBe(false);
    expect(boundToSnapshot(map(layer("a", "1")), map(layer("a", "1"), layer("c", "1")))).toBe(false);
    expect(boundToSnapshot(map(layer("a", "1"), layer("c", "1")), map(layer("c", "1"), layer("a", "1")))).toBe(false);
    expect(boundToSnapshot(map(layer("a", "1"), layer("b", "1", false)), map(layer("a", "1"), layer("b", "1")))).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PickingInfo } from "@deck.gl/core";
import type * as maplibregl from "maplibre-gl";
import { pointerHandlers, type HoverInfo, type PinnedPopup } from "./canvas-pointer";
import type { RenderedLayer } from "./MapCanvas";

/**
 * A drawn sketch's layer with both interaction lists explicitly empty: its
 * builder render carries the shape's identity and kind and nothing else.
 * Hovering shows nothing and a click pins nothing, yet the click still
 * selects the shape, which is what vertex editing starts from.
 */

const sketch = { id: "L", tooltip: [], popup: [], viz: { type: "points" } } as unknown as RenderedLayer;

function pointer(pick: (layerId: string, feature: { featureId: string | null; kind: string | null }) => boolean) {
  const canvas = { style: { cursor: "" } };
  const hover: (HoverInfo | null)[] = [];
  const pinned: (PinnedPopup | null)[] = [];
  const handlers = pointerHandlers({
    instance: {
      getCanvas: () => canvas,
      getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
      easeTo: vi.fn(),
      getZoom: () => 4,
    } as unknown as maplibregl.Map,
    interactive: true,
    isDragging: () => false,
    pinnedRef: { current: null },
    layersRef: { current: [sketch] },
    markScaleRef: { current: 1 },
    onFeaturePickRef: { current: pick },
    setHover: (value) => hover.push(value),
    setPinned: (value) => pinned.push(value),
  });
  return { handlers, canvas, hover, pinned };
}

const narrowed = { feature_id: "f1", kind: "polygon", __anchor: [1.5, 1.4] };
const at = (properties: Record<string, unknown>) =>
  ({ object: { properties }, layer: { id: "L" }, index: 0, x: 10, y: 10, coordinate: [1.5, 1.4] }) as unknown as PickingInfo;

describe("sketch picking over a narrowed render with empty interaction lists", () => {
  it("selects the clicked shape by its identity and kind", () => {
    const pick = vi.fn(() => true);
    const { handlers, pinned } = pointer(pick);
    handlers.onClick(at(narrowed));
    expect(pick).toHaveBeenCalledWith("L", { featureId: "f1", kind: "polygon" });
    expect(pinned).toEqual([]);
  });

  it("shows no tooltip and pins no pop-up, while the shape stays clickable", () => {
    const { handlers, canvas, hover, pinned } = pointer(() => false);
    handlers.onHover(at(narrowed));
    expect(canvas.style.cursor).toBe("pointer");
    expect(hover).toEqual([null]);
    handlers.onClick(at(narrowed));
    expect(pinned).toEqual([null]);
  });
});

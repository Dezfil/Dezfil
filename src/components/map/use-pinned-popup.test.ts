import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PickingInfo } from "@deck.gl/core";
import type * as maplibregl from "maplibre-gl";
import { HookHarness, hookReact } from "../workflow-canvas/hook-harness";
vi.mock("react", () => hookReact);
import { armDrawTool, closeDraw, drawState, openDraw, resetDraw, setDrawSelection } from "../builder/draw/draw-mode";
import { pointerHandlers } from "./canvas-pointer";
import type { RenderedLayer } from "./MapCanvas";
import { usePinnedPopup } from "./use-pinned-popup";

/**
 * A feature's pop-up pinned on the map, and what ends it: Escape, with
 * the builder's draw mode on the page too, and the feature it describes
 * leaving the map. The card is pinned the way the canvas pins it, by a
 * click through the pointer handlers; the window delivers a key to its
 * capture listeners first and to its bubbling ones only if none stopped
 * it, as a browser does.
 */

type Listener = (event: unknown) => void;
let capture: Set<Listener>;
let bubble: Set<Listener>;
const unmounts: (() => void)[] = [];

beforeEach(() => {
  capture = new Set();
  bubble = new Set();
  const phase = (options?: boolean | AddEventListenerOptions) => (options === true || (typeof options === "object" && options.capture) ? capture : bubble);
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: Listener, options?: boolean | AddEventListenerOptions) => { if (type === "keydown") phase(options).add(fn); },
    removeEventListener: (type: string, fn: Listener, options?: boolean | AddEventListenerOptions) => { if (type === "keydown") phase(options).delete(fn); },
  });
});
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount());
  resetDraw();
  vi.unstubAllGlobals();
});

/** A key pressed with nothing in particular focused. */
function press(key: string) {
  let stopped = false;
  let prevented = false;
  const event = {
    key, target: null, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false,
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  };
  for (const fn of [...capture]) fn(event);
  if (!stopped) for (const fn of [...bubble]) fn(event);
}

const feature = (id: string, kind = "point") => ({ type: "Feature", geometry: null, properties: { feature_id: id, kind, name: `Shape ${id}` } });
const layer = (id: string, features: unknown[], extra: Partial<RenderedLayer> = {}): RenderedLayer =>
  ({ id, style: {}, visible: true, popup: null, tooltip: null, geojson: { type: "FeatureCollection", features }, ...extra }) as unknown as RenderedLayer;

function canvas(initial: RenderedLayer[]) {
  let layers = initial;
  const h = new HookHarness(() => usePinnedPopup(layers));
  unmounts.push(() => h.unmount());
  const handlers = pointerHandlers({
    instance: {
      getCanvas: () => ({ style: { cursor: "" } }),
      getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
      easeTo: vi.fn(),
      getZoom: () => 4,
    } as unknown as maplibregl.Map,
    interactive: true,
    isDragging: () => false,
    pinnedRef: h.value.pinnedRef,
    layersRef: { get current() { return layers; } },
    markScaleRef: { current: 1 },
    onFeaturePickRef: { current: null },
    setHover: () => {},
    setPinned: (value) => { h.value.setPinned(value); h.render(); },
  });
  /** A click on the feature at this index of the layer's data. */
  const click = (layerId: string, index: number) => {
    const data = layers.find((l) => l.id === layerId)!.geojson as { features: { properties: Record<string, unknown> }[] };
    handlers.onClick({ object: data.features[index], layer: { id: layerId }, index, x: 100, y: 100, coordinate: [13.4, 52.5] } as unknown as PickingInfo);
  };
  const draw = (next: RenderedLayer[]) => { layers = next; h.render(); };
  return { h, click, draw, pinned: () => h.render().pinned };
}

describe("Escape with the draw dock open", () => {
  it("closes the pinned pop-up first when draw has nothing of its own in progress, and the dock on the next press", () => {
    const c = canvas([layer("L", [feature("a")])]);
    openDraw();
    c.click("L", 0);
    expect(c.pinned()).not.toBeNull();
    press("Escape");
    expect(c.pinned(), "the pop-up stayed pinned under the draw dock").toBeNull();
    expect(drawState().open, "the press that closed the pop-up also closed the dock").toBe(true);
    press("Escape");
    expect(drawState().open).toBe(false);
  });

  it("disarms an armed tool before it closes the pinned pop-up", () => {
    const c = canvas([layer("L", [feature("a")])]);
    openDraw();
    c.click("L", 0);
    armDrawTool("polygon");
    press("Escape");
    expect(drawState().tool).toBeNull();
    expect(c.pinned()).not.toBeNull();
    press("Escape");
    expect(c.pinned(), "the pop-up stayed pinned under the draw dock").toBeNull();
    expect(drawState().open).toBe(true);
  });

  it("clears a drawn shape's selection before it closes the pinned pop-up", () => {
    const c = canvas([layer("L", [feature("a")])]);
    closeDraw();
    c.click("L", 0);
    setDrawSelection({ layerId: "S", table: "sketch", featureId: "s1", kind: "polygon" });
    press("Escape");
    expect(drawState().selected).toBeNull();
    expect(c.pinned()).not.toBeNull();
    press("Escape");
    expect(c.pinned()).toBeNull();
  });

  it("still closes the dock on Escape when no pop-up is pinned", () => {
    canvas([layer("L", [feature("a")])]);
    openDraw();
    press("Escape");
    expect(drawState().open).toBe(false);
  });
});

describe("the feature the pinned pop-up describes", () => {
  it("closes the pop-up when that drawn shape leaves its layer's data", () => {
    const c = canvas([layer("L", [feature("a"), feature("b")])]);
    c.click("L", 1);
    expect(c.pinned()).not.toBeNull();
    c.draw([layer("L", [feature("a")])]);
    expect(c.pinned(), "the pop-up outlived the shape it describes").toBeNull();
  });

  it("closes the pop-up when its layer leaves the map", () => {
    const c = canvas([layer("L", [feature("a")]), layer("M", [feature("m")])]);
    c.click("L", 0);
    c.draw([layer("M", [feature("m")])]);
    expect(c.pinned(), "the pop-up outlived its layer").toBeNull();
  });

  it("keeps the pop-up while the shape is still drawn, whatever else changed", () => {
    const c = canvas([layer("L", [feature("a"), feature("b")])]);
    c.click("L", 1);
    c.draw([layer("L", [feature("b"), feature("c")])]);
    expect(c.pinned()).not.toBeNull();
    // Between answers a layer has no data to read: nothing is known gone.
    c.draw([layer("L", [], { geojson: null })]);
    expect(c.pinned()).not.toBeNull();
  });

  it("keeps a pop-up for a feature with no identity of its own across new data", () => {
    const plain = (name: string) => ({ type: "Feature", geometry: null, properties: { name } });
    const c = canvas([layer("L", [plain("x"), plain("y")])]);
    c.click("L", 1);
    c.draw([layer("L", [plain("z")])]);
    expect(c.pinned()).not.toBeNull();
  });
});

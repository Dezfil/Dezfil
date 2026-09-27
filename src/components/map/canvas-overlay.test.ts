import { describe, expect, it, vi } from "vitest";
import { attachCanvasOverlay } from "./canvas-overlay";
import type { PointerContext } from "./canvas-pointer";

const mocks = vi.hoisted(() => ({
  overlay: { setProps: vi.fn() },
  create: vi.fn(),
  handlers: { onHover: vi.fn(), onClick: vi.fn() },
  capture: vi.fn(),
}));
vi.mock("@deck.gl/mapbox", () => ({
  MapboxOverlay: class {
    constructor(options: unknown) {
      mocks.create(options);
      return mocks.overlay;
    }
  },
}));
vi.mock("./canvas-pointer", () => ({ pointerHandlers: () => mocks.handlers }));
vi.mock("./capture", () => ({ wireCaptureHandles: mocks.capture }));

describe("canvas overlay lifetime", () => {
  it("mounts a separate picking canvas before exposing capture and readiness", () => {
    const order: string[] = [];
    const instance = { addControl: vi.fn(() => order.push("mount")) };
    const capture = {
      fallbackColor: () => "#ffffff",
      deckLayers: () => [],
      expectedLayerCount: () => 2,
      onReadiness: vi.fn(),
    };
    mocks.capture.mockImplementationOnce(() => {
      order.push("capture");
      return () => {};
    });
    const mounted = attachCanvasOverlay({ instance } as unknown as PointerContext, capture);
    expect(order).toEqual(["mount", "capture"]);
    expect(mocks.create).toHaveBeenLastCalledWith({
      interleaved: false, layers: [], ...mocks.handlers,
    });
    expect(instance.addControl).toHaveBeenCalledWith(mounted.overlay);
    expect(mocks.capture).toHaveBeenLastCalledWith({ ...capture, instance, overlay: mounted.overlay });
  });

  it("withdraws both consumers and stops readiness polling before map disposal", () => {
    const order: string[] = [];
    mocks.capture.mockReturnValueOnce(() => order.push("stop readiness"));
    const mounted = attachCanvasOverlay({
      instance: { addControl: vi.fn() },
    } as unknown as PointerContext, {
      fallbackColor: () => "#ffffff", deckLayers: () => [],
      onSnapshotHandle: (handle) => { if (handle === null) order.push("clear snapshot"); },
      onCaptureHandle: (handle) => { if (handle === null) order.push("clear capture"); },
    });
    mounted.dispose();
    expect(order).toEqual(["clear snapshot", "clear capture", "stop readiness"]);
  });
});

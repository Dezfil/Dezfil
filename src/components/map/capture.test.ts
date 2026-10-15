import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapLibreOverlay } from "@deck.gl/maplibre";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wireCaptureHandles } from "./capture";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  let paint: (() => void) | undefined;
  const instance = {
    loaded: vi.fn(() => false), areTilesLoaded: vi.fn(() => false), isMoving: vi.fn(() => false),
    on: vi.fn(), off: vi.fn(), once: vi.fn((_event: string, listener: () => void) => { paint = listener; }),
    triggerRepaint: vi.fn(),
  };
  const onReadiness = vi.fn();
  const layers = [{ isLoaded: true }];
  const dispose = wireCaptureHandles({
    instance: instance as unknown as MapLibreMap, overlay: {} as MapLibreOverlay,
    fallbackColor: () => "#ffffff", deckLayers: () => layers, expectedLayerCount: () => 1, onReadiness,
  });
  return { instance, layers, onReadiness, dispose, paint: () => paint?.() };
}

it("keeps waiting for pending tiles without a cut", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.onReadiness.mock.calls).toEqual([[false]]);
  expect(f.instance.triggerRepaint).not.toHaveBeenCalled();
  f.instance.loaded.mockReturnValue(true); f.instance.areTilesLoaded.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.onReadiness).toHaveBeenLastCalledWith(true);
  f.dispose();
});

it("settles pending tiles within one poll and a paint after a cut", async () => {
  const f = fixture();
  document.documentElement.dataset.exportTilesSettled = "true";
  await vi.advanceTimersByTimeAsync(200);
  expect(f.instance.triggerRepaint).toHaveBeenCalledOnce();
  expect(f.onReadiness).toHaveBeenLastCalledWith(false);
  f.paint();
  expect(f.onReadiness).toHaveBeenLastCalledWith(true);
  expect(f.instance.loaded()).toBe(false);
  expect(f.instance.areTilesLoaded()).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.instance.triggerRepaint).toHaveBeenCalledOnce();
  f.dispose();
  expect(f.instance.off).toHaveBeenCalledWith("render", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["moving", "uncommitted", "loading"])("a cut still waits for %s data or camera state", async gate => {
  const f = fixture();
  if (gate === "moving") f.instance.isMoving.mockReturnValue(true);
  if (gate === "uncommitted") f.layers.pop();
  if (gate === "loading") f.layers[0].isLoaded = false;
  document.documentElement.dataset.exportTilesSettled = "true";
  await vi.advanceTimersByTimeAsync(200);
  f.paint();
  expect(f.onReadiness).toHaveBeenLastCalledWith(false);
  f.instance.isMoving.mockReturnValue(false);
  f.layers.splice(0, f.layers.length, { isLoaded: true });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.onReadiness).toHaveBeenLastCalledWith(true);
  f.dispose();
});

it("retains a cut that arrived before the map mounted", () => {
  document.documentElement.dataset.exportTilesSettled = "true";
  const f = fixture();
  expect(f.instance.triggerRepaint).toHaveBeenCalledOnce();
  f.paint();
  expect(f.onReadiness).toHaveBeenLastCalledWith(true);
  f.dispose();
});

import { describe, expect, it, vi } from "vitest";
import * as maplibregl from "maplibre-gl";
import { WebMercatorViewport } from "@deck.gl/core";
import { alignmentPoint } from "../../../scripts/map-alignment-fixture.mjs";
import { coveredCamera } from "../../../e2e/camera-bounds-oracle";
import { cardDefinition } from "@/lib/pictures/card";
import { attachCanvasCamera, CANVAS_CAMERA_OPTIONS } from "./canvas-camera";

function harness(height = 512, padding = { top: 0, bottom: 0 }) {
  const handlers = new Map<string, () => void>();
  let constrain: (center: maplibregl.LngLat, zoom: number) => { center: maplibregl.LngLat; zoom: number };
  const state = { padding, minZoom: -2, maxZoom: 24 };
  const canvas = { clientHeight: height };
  const host = { clientHeight: height, dataset: {} as Record<string, string> };
  const live = { lng: 12.1234567, lat: -13.1234567, zoom: 10.1234567, pitch: 30.1234567, bearing: -17.1234567 };
  const map = {
    setTransformConstrain: vi.fn((callback: typeof constrain) => { constrain = callback; }),
    getCanvas: () => canvas,
    getPadding: () => state.padding,
    getMinZoom: () => state.minZoom,
    getMaxZoom: () => state.maxZoom,
    setMinZoom: vi.fn((zoom: number) => { state.minZoom = zoom; }),
    jumpTo: vi.fn(),
    on: vi.fn((name: string, callback: () => void) => { handlers.set(name, callback); }),
    off: vi.fn((name: string) => { handlers.delete(name); }),
    getCenter: () => ({ lng: live.lng, lat: live.lat }),
    getZoom: () => live.zoom, getPitch: () => live.pitch, getBearing: () => live.bearing,
  };
  const dispose = attachCanvasCamera(map as unknown as maplibregl.Map, host as unknown as HTMLElement, live);
  return { map, host, live, dispose, handlers, constrain: (lat: number, zoom: number) => constrain(new maplibregl.LngLat(12, lat), zoom) };
}

describe("shared canvas camera", () => {
  it("sets explicit pitch 60, zoom 24 and short-stage floor -2", () => {
    expect(CANVAS_CAMERA_OPTIONS).toStrictEqual({ minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 60, zoomLevelsToOverscale: undefined });
    expect(Object.hasOwn(CANVAS_CAMERA_OPTIONS, "zoomLevelsToOverscale")).toBe(true);
  });
  it.each([1, -1])("covers the %s pole at zoom 10 using an independent 512px fixture", sign => {
    const h = harness();
    // Inverse spherical Mercator of northing fraction 1/2048, computed
    // independently from the specification's half-canvas / world size.
    expect(h.constrain(sign * 85.051129, 10).center.lat).toBeCloseTo(sign * 85.035941506574, 10);
    expect(h.constrain(sign * 85, 10).center.lat).toBeCloseTo(sign * 85, 10);
    h.dispose();
  });
  it("raises zoom 0 to 1 for 1024px and preserves short-stage negative zoom on resize", () => {
    const h = harness(1024);
    expect(h.map.setMinZoom).toHaveBeenLastCalledWith(1);
    expect(h.constrain(0, 0).zoom).toBe(1);
    h.host.clientHeight = 256;
    h.map.getCanvas().clientHeight = 256;
    h.handlers.get("resize")!();
    expect(h.map.setMinZoom).toHaveBeenLastCalledWith(-1);
    expect(h.constrain(0, -0.5).zoom).toBe(-0.5);
    h.host.clientHeight = 64;
    h.handlers.get("resize")!();
    expect(h.map.setMinZoom).toHaveBeenLastCalledWith(-2);
    h.dispose();
  });
  it("keeps asymmetric-padding coverage measured from the actual center", () => {
    const h = harness(512, { top: 128, bottom: 0 });
    // Northing = 320/524288 north and 1-192/524288 south.
    expect(h.constrain(85.051129, 10).center.lat).toBeCloseTo(85.03213742967942, 9);
    expect(h.constrain(-85.051129, 10).center.lat).toBeCloseTo(-85.03974267783215, 9);
    h.dispose();
  });
  it.each([1, -1])("keeps the %s pole alignment fixture inside both the saved card and the square export", sign => {
    const requested = { lng: 12, lat: sign * 85.051129, zoom: 10, pitch: 0, bearing: 0 };
    const builder = harness(1100, { top: 62, bottom: 14 });
    const saved = { ...requested, lat: builder.constrain(requested.lat, requested.zoom).center.lat };
    expect(saved.lat).toBeCloseTo(coveredCamera(requested, 1100, 62, 14).lat, 10);
    const card = cardDefinition(saved, "light");
    // The short card keeps the padded builder's saved centre. A landmark
    // visible near the builder's edge can be outside this centre band.
    for (const { viewport, size } of [card, { viewport: requested, size: { width: 512, height: 512 } }]) {
      const render = harness(size.height);
      const camera = render.constrain(viewport.lat, viewport.zoom);
      expect(camera.center.lat).toBeCloseTo(coveredCamera(viewport, size.height).lat, 10);
      if (size === card.size) expect(camera.center.lat).toBeCloseTo(saved.lat, 10);
      const [x, y] = new WebMercatorViewport({
        ...size, longitude: viewport.lng, latitude: camera.center.lat,
        zoom: camera.zoom, pitch: viewport.pitch, bearing: viewport.bearing,
      }).project(alignmentPoint(sign));
      expect(x).toBeCloseTo(size.width / 2, 6);
      // Keep the entire 30px basemap disc and its smaller data disc visible.
      expect(y, "landmark clears the top edge").toBeGreaterThan(30);
      expect(y, "landmark clears the bottom edge").toBeLessThan(size.height - 30);
      render.dispose();
    }
    builder.dispose();
  });
  it("installs the public constraint before reapplying the original opening request", () => {
    const h = harness();
    expect(h.map.jumpTo).toHaveBeenCalledExactlyOnceWith({
      center: [h.live.lng, h.live.lat], zoom: h.live.zoom,
    });
    expect(h.map.setTransformConstrain.mock.invocationCallOrder[0])
      .toBeLessThan(h.map.jumpTo.mock.invocationCallOrder[0]);
    const renderSubscription = h.map.on.mock.calls.findIndex(([event]) => event === "render");
    expect(h.map.jumpTo.mock.invocationCallOrder[0])
      .toBeLessThan(h.map.on.mock.invocationCallOrder[renderSubscription]);
    h.dispose();
  });
  it("measures the renderer canvas independently of the host and device pixel ratio", () => {
    const h = harness(512, { top: 128, bottom: 0 });
    h.host.clientHeight = 900;
    // Only the renderer's CSS height is relevant to world coverage.
    expect(h.constrain(85.051129, 10).center.lat).toBeCloseTo(85.03213742967942, 9);
    h.handlers.get("render")!();
    expect(JSON.parse(h.host.dataset.mapCamera).height).toBe(512);
    h.dispose();
  });
  it("reads the unrounded live camera only after paint and removes its listeners on teardown", () => {
    const h = harness();
    expect(h.host.dataset.mapCamera).toBeUndefined();
    h.handlers.get("render")!();
    expect(JSON.parse(h.host.dataset.mapCamera)).toEqual({ ...h.live, height: 512, padding: { top: 0, bottom: 0 } });
    expect(h.host.dataset.cameraPainted).toBe("true");
    h.live.pitch = 59.7654321;
    h.live.lat = 85.035941506574;
    h.handlers.get("render")!();
    expect(JSON.parse(h.host.dataset.mapCamera).pitch).toBe(59.7654321);
    expect(JSON.parse(h.host.dataset.mapCamera).lat).toBe(85.035941506574);
    h.dispose();
    expect(h.handlers.size).toBe(0);
    expect(h.host.dataset).toEqual({});
  });
});

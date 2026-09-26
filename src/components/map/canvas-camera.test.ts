import { describe, expect, it, vi } from "vitest";
import maplibregl from "maplibre-gl";
import { attachCanvasCamera, CANVAS_CAMERA_OPTIONS } from "./canvas-camera";

function harness(height = 512, padding = { top: 0, bottom: 0 }) {
  const handlers = new Map<string, () => void>();
  let constrain: (center: maplibregl.LngLat, zoom: number) => { center: maplibregl.LngLat; zoom: number };
  const transform = { height, padding, minZoom: -2, maxZoom: 24,
    setConstrainOverride: vi.fn((callback: typeof constrain) => { constrain = callback; }) };
  const host = { clientHeight: height, dataset: {} as Record<string, string> };
  const live = { lng: 12.1234567, lat: -13.1234567, zoom: 10.1234567, pitch: 30.1234567, bearing: -17.1234567 };
  const map = {
    transform,
    setMinZoom: vi.fn((zoom: number) => { transform.minZoom = zoom; }),
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
    expect(CANVAS_CAMERA_OPTIONS).toEqual({ minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 60 });
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
    h.map.transform.height = 256;
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

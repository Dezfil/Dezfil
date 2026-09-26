import { describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";
import { cameraHandle } from "./camera-handle";

function mapStub(read: {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}): maplibregl.Map {
  return {
    getCenter: () => ({ lng: read.lng, lat: read.lat }),
    getZoom: () => read.zoom,
    getPitch: () => read.pitch,
    getBearing: () => read.bearing,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    jumpTo: vi.fn(),
    easeTo: vi.fn(),
  } as unknown as maplibregl.Map;
}

describe("the imperative camera handle", () => {
  it("reads the camera MapLibre is drawing, not a settled copy", () => {
    const live = {
      lng: 13.4,
      lat: 52.5,
      zoom: 23,
      pitch: 15,
      bearing: -12,
    };
    const handle = cameraHandle(mapStub(live), () => ({}));

    expect(handle.currentViewport()).toEqual(live);

    // A camera ease mutates MapLibre before its eventual moveend. The
    // getter observes that live value on every call, which is the seam
    // export availability and guarded opening depend on.
    live.zoom = 24;
    live.lng = 14;
    expect(handle.currentViewport()).toEqual({ ...live });
  });
});

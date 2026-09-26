import { describe, expect, it, vi } from "vitest";
import maplibregl from "maplibre-gl";
import { attachCanvasCamera, CANVAS_CAMERA_OPTIONS } from "./canvas-camera";
import { coveredCamera } from "../../../e2e/camera-bounds-oracle";

type Transform = maplibregl.Map["transform"];
type Camera = Pick<maplibregl.Map, "jumpTo" | "setPadding" | "on" | "off" | "fire" |
  "getCenter" | "getZoom" | "getPitch" | "getBearing">;
// Execute the installed renderer's camera/transform without a DOM or WebGL.
// Runtime imports keep its source under its own TypeScript compiler settings.
const [{ MercatorTransform }, { Camera: RendererCamera }, { MercatorCameraHelper }] = await Promise.all([
  vi.importActual<{ MercatorTransform: new (options: typeof CANVAS_CAMERA_OPTIONS) => Transform }>(
    "maplibre-gl/src/geo/projection/mercator_transform"),
  vi.importActual<{ Camera: new (transform: Transform, helper: unknown,
    options: { bearingSnap: number; zoomSnap: number }) => Camera }>("maplibre-gl/src/ui/camera"),
  vi.importActual<{ MercatorCameraHelper: new () => unknown }>("maplibre-gl/src/geo/projection/mercator_camera_helper"),
]);

const padding = { top: 62, bottom: 14, left: 438, right: 14 };
// The supervising session's 1600 × 1100 builder canvas. The unpadded
// constructor values below are measured from MapLibre 5.24.0; the final
// fixtures come from spherical Mercator at 574px north / 526px south.
const endpoints = [
  { pole: "north", lat: 85.051129, zoom: 10, pitch: 0,
    constructorLat: 85.01844273177147, coveredLat: 85.0170113070605 },
  { pole: "south", lat: -85.051129, zoom: 10, pitch: 0,
    constructorLat: -85.01844273177144, coveredLat: -85.01987330316322 },
  { pole: "north", lat: 85.051129, zoom: 10.1234567, pitch: 30.1234567,
    constructorLat: 85.02113156626416, coveredLat: 85.01981824383927 },
  { pole: "south", lat: -85.051129, zoom: 10.1234567, pitch: 30.1234567,
    constructorLat: -85.02113156626416, coveredLat: -85.02244410029212 },
];

describe("canvas camera initialization after MapLibre's constructor", () => {
  it.each(endpoints)("paints only padded coverage for $pole at zoom $zoom", fixture => {
    const requested = { lng: 12.1234567, lat: fixture.lat, zoom: fixture.zoom,
      pitch: fixture.pitch, bearing: -17.1234567 };
    const transform = new MercatorTransform(CANVAS_CAMERA_OPTIONS);
    const camera = new RendererCamera(transform, new MercatorCameraHelper(), { bearingSnap: 7, zoomSnap: 0 });
    const instance = Object.assign(camera, {
      transform, setMinZoom: maplibregl.Map.prototype.setMinZoom, _update: vi.fn(),
    }) as unknown as maplibregl.Map;
    // Match Map's constructor, then MapCanvas's pre-attachment padding.
    instance.jumpTo({ center: [requested.lng, requested.lat], zoom: requested.zoom,
      pitch: requested.pitch, bearing: requested.bearing });
    transform.resize(1600, 1100, true);
    expect(instance.getCenter().lat).toBeCloseTo(fixture.constructorLat, 10);
    instance.setPadding(padding);

    const host = { clientHeight: 1100, dataset: {} as Record<string, string> };
    const dispose = attachCanvasCamera(instance, host as unknown as HTMLElement, requested);
    try {
      // The oracle and direct product clamp already agree; the regression
      // is whether initialization actually applies that clamp to the request.
      expect(coveredCamera(requested, 1100, padding.top, padding.bottom).lat).toBeCloseTo(fixture.coveredLat, 10);
      expect(transform.applyConstrain(new maplibregl.LngLat(requested.lng, requested.lat), requested.zoom).center.lat)
        .toBeCloseTo(fixture.coveredLat, 10);
      expect(host.dataset.cameraPainted).toBeUndefined();
      instance.fire("render");
      const painted = JSON.parse(host.dataset.mapCamera);
      expect(painted.lat).toBeCloseTo(fixture.coveredLat, 10);
      for (const field of ["lng", "zoom", "pitch", "bearing"] as const) {
        expect(painted[field], field).toBeCloseTo(requested[field], 10);
      }
      expect(painted.padding).toEqual(padding);
      expect(painted.height).toBe(1100);
    } finally {
      dispose();
    }
  });
});

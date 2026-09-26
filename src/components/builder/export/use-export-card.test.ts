import { describe, expect, it } from "vitest";
import type { CameraHandle } from "../../map/camera-handle";
import type { Viewport } from "../../map/MapCanvas";
import { exportCameraSnapshot } from "./use-export-card";

const fallback: Viewport = { lng: 1, lat: 2, zoom: 3 };
const settled: Viewport = { lng: 4, lat: 5, zoom: 22 };

describe("the export camera snapshot", () => {
  it("reads the live handle ahead of a stale moveend snapshot", () => {
    const live = { lng: 6, lat: 7, zoom: 24, pitch: 20, bearing: 8 };
    const handle = {
      currentViewport: () => live,
    } as CameraHandle;

    expect(exportCameraSnapshot(handle, settled, fallback)).toBe(live);
  });

  it("preserves the settled and stored fallbacks when WebGL made no handle", () => {
    expect(exportCameraSnapshot(null, settled, fallback)).toBe(settled);
    expect(exportCameraSnapshot(null, null, fallback)).toBe(fallback);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  clampBounds,
  formatCoords,
  formatReaderCoords,
  formatZoom,
  formatBbox,
  createStatusChannel,
  readerCoordDecimals,
  readerCoordStep,
  type MapStatus,
} from "./map-status";
import type { Bounds } from "./geo-bounds";

describe("status bar formatting", () => {
  it("formats coordinates longitude-first to 5 decimals", () => {
    expect(formatCoords({ lng: 8.586901234, lat: 50.094605678 })).toBe(
      "8.58690, 50.09461",
    );
  });

  it("formats zoom to 2 decimals", () => {
    expect(formatZoom(12.0864)).toBe("12.09");
    expect(formatZoom(3)).toBe("3.00");
  });

  it("formats the bbox as w, s, e, n to 4 decimals", () => {
    const bounds: Bounds = [
      [8.56123, 50.05567],
      [8.76801, 50.14454],
    ];
    expect(formatBbox(bounds)).toBe("8.5612, 50.0557, 8.7680, 50.1445");
  });

  it("clamps world-wrapped bounds into valid WGS84", () => {
    // Zoomed all the way out, the map reports the repeating world.
    const world: Bounds = [
      [-310.78, -85.05],
      [297.42, 85.05],
    ];
    expect(clampBounds(world)).toEqual([-180, -85.05, 180, 85.05]);
    expect(formatBbox(world)).toBe(
      "-180.0000, -85.0500, 180.0000, 85.0500",
    );
  });

  it("wraps repeated-world cursor longitudes instead of pinning at ±180", () => {
    // Red-proven against the earlier formatter, which clamped these to
    // ±180 — panning past the antimeridian stuck the readout at 180.
    expect(formatCoords({ lng: 181, lat: 12 })).toBe("-179.00000, 12.00000");
    expect(formatCoords({ lng: 250.5, lat: 12 })).toBe(
      "-109.50000, 12.00000",
    );
    expect(formatCoords({ lng: -250.5, lat: -12 })).toBe(
      "109.50000, -12.00000",
    );
    // The wrap seam itself: 180 stays 180, -180 reads as 180.
    expect(formatCoords({ lng: 180, lat: 0 })).toBe("180.00000, 0.00000");
    expect(formatCoords({ lng: -180, lat: 0 })).toBe("180.00000, 0.00000");
  });

  it("never renders negative zero", () => {
    expect(formatCoords({ lng: -1e-9, lat: -1e-9 })).toBe(
      "0.00000, 0.00000",
    );
    expect(formatZoom(-1e-9)).toBe("0.00");
  });
});

describe("reader coordinate readout", () => {
  it("formats latitude first — the reader order, diverging from SQL order", () => {
    expect(formatReaderCoords({ lng: 8.586901, lat: 50.094605 }, 17)).toBe(
      "50.09461, 8.58690",
    );
  });

  it("tracks zoom with monotonic precision, coarse at world zoom", () => {
    const cursor = { lng: 8.586901234, lat: 50.094605678 };
    const zooms = [0, 2, 3, 5, 6, 8, 9, 11, 12, 16, 22];
    let previous = 0;
    for (const zoom of zooms) {
      const decimals = readerCoordDecimals(zoom);
      expect(decimals).toBeGreaterThanOrEqual(previous);
      previous = decimals;
      const [lat] = formatReaderCoords(cursor, zoom).split(", ");
      expect(lat.split(".")[1]?.length ?? 0).toBe(decimals);
    }
    // Markedly fewer decimals at world zoom than at street zoom.
    expect(readerCoordDecimals(0)).toBeLessThan(readerCoordDecimals(16) - 2);
  });

  it("never claims a step finer than a pixel resolves", () => {
    // The displayed step must be at least one pixel's worth of longitude
    // at the equator, 360 / (512 · 2^zoom) — the independent resolution
    // the thresholds are derived from. The canvas permits zooms down to
    // -2 for short viewports, so the negative range is covered too.
    for (let zoom = -2; zoom <= 22; zoom += 0.5) {
      const degreesPerPixel = 360 / (512 * 2 ** zoom);
      expect(readerCoordStep(zoom)).toBeGreaterThanOrEqual(
        Math.min(degreesPerPixel, 1e-5),
      );
    }
  });

  it("quantizes to whole-degree steps below zoom 0", () => {
    // At zoom -2 a pixel spans 2.8125°: the readout moves in 3° steps.
    expect(readerCoordStep(-2)).toBe(3);
    expect(formatReaderCoords({ lng: 10.4, lat: 46.6 }, -2)).toBe("48, 9");
    expect(formatReaderCoords({ lng: 10.4, lat: 46.6 }, -1)).toBe("46, 10");
    // Quantization respects the poles and the antimeridian seam.
    expect(formatReaderCoords({ lng: -179.9, lat: 89.9 }, -2)).toBe(
      "90, 180",
    );
  });

  it("re-canonicalizes the seam after rounding", () => {
    // Rounding can undo the wrap: 180.25 wraps to -179.75, which would
    // display as -180 at zero decimals without the post-round fix.
    expect(formatReaderCoords({ lng: 180.25, lat: 0 }, 0)).toBe("0, 180");
    expect(formatCoords({ lng: -179.9999999, lat: 0 })).toBe(
      "180.00000, 0.00000",
    );
  });

  it("wraps the antimeridian and clamps latitude", () => {
    expect(formatReaderCoords({ lng: 181, lat: 12 }, 17)).toBe(
      "12.00000, -179.00000",
    );
    expect(formatReaderCoords({ lng: -250.5, lat: 95 }, 17)).toBe(
      "90.00000, 109.50000",
    );
  });

  it("never renders negative zero at coarse precision", () => {
    // Zoom 0 resolves no decimals at all — the bare "-0" seam.
    expect(formatReaderCoords({ lng: -0.04, lat: -0.04 }, 0)).toBe("0, 0");
  });
});

describe("status channel", () => {
  const status: MapStatus = {
    cursor: { lng: 1, lat: 2 },
    zoom: 5,
    bounds: [
      [0, 0],
      [1, 1],
    ],
  };

  it("starts empty and holds the latest emitted value", () => {
    const ch = createStatusChannel();
    expect(ch.get()).toBeNull();
    ch.emit(status);
    ch.emit({ ...status, zoom: 6 });
    expect(ch.get()?.zoom).toBe(6);
  });

  it("notifies subscribers on emit and stops after unsubscribe", () => {
    const ch = createStatusChannel();
    const onChange = vi.fn();
    const off = ch.subscribe(onChange);
    ch.emit(status);
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    ch.emit(status);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

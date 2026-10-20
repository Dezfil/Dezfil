import { describe, expect, it } from "vitest";
import { FIT_MAX_ZOOM, fitCamera, type FitCamera } from "./fit-camera";
import type { Bounds } from "./geo-bounds";

// The test's own Web Mercator, written from the projection's definition,
// to place a coordinate on the screen a camera shows.
const world = (lng: number, lat: number) => {
  const r = (lat * Math.PI) / 180;
  return [((lng + 180) / 360) * 512, (0.5 - Math.log((1 + Math.sin(r)) / (1 - Math.sin(r))) / (4 * Math.PI)) * 512];
};
function onScreen(camera: FitCamera, size: { width: number; height: number }, lng: number, lat: number) {
  const [x, y] = world(lng, lat);
  const [cx, cy] = world(camera.lng, camera.lat);
  const k = 2 ** camera.zoom;
  const b = (-camera.bearing * Math.PI) / 180;
  const dx = (x - cx) * k;
  const dy = (y - cy) * k;
  return [size.width / 2 + Math.cos(b) * dx - Math.sin(b) * dy, size.height / 2 + Math.sin(b) * dx + Math.cos(b) * dy];
}
function screenBox(camera: FitCamera, size: { width: number; height: number }, [[w, s], [e, n]]: Bounds) {
  const corners = [[w, n], [e, n], [e, s], [w, s]].map(([lng, lat]) => onScreen(camera, size, lng, lat));
  return {
    left: Math.min(...corners.map(([x]) => x)),
    right: Math.max(...corners.map(([x]) => x)),
    top: Math.min(...corners.map(([, y]) => y)),
    bottom: Math.max(...corners.map(([, y]) => y)),
  };
}
const even = (p: number) => ({ top: p, right: p, bottom: p, left: p });
const flat = { bearing: 0, pitch: 0 };

describe("fitCamera", () => {
  const card = { width: 990, height: 424 };

  it("fits a wide box to the frame's width inside the margin and centres it vertically", () => {
    const bounds: Bounds = [[-10, 40], [30, 50]];
    const camera = fitCamera(bounds, card, even(33), flat)!;
    const box = screenBox(camera, card, bounds);
    expect(box.left).toBeCloseTo(33, 6);
    expect(box.right).toBeCloseTo(990 - 33, 6);
    expect(box.top - 0).toBeGreaterThan(33);
    expect(box.top).toBeCloseTo(424 - box.bottom, 6);
  });

  it("fits a tall box to the frame's height and centres it horizontally", () => {
    const bounds: Bounds = [[-75, -55], [-66, -17]];
    const camera = fitCamera(bounds, card, even(33), flat)!;
    const box = screenBox(camera, card, bounds);
    expect(box.top).toBeCloseTo(33, 6);
    expect(box.bottom).toBeCloseTo(424 - 33, 6);
    expect(box.left).toBeCloseTo(990 - box.right, 6);
  });

  it("keeps the bearing and pitch, and fits the rotated box", () => {
    const bounds: Bounds = [[2.2, 48.8], [2.5, 48.9]];
    const camera = fitCamera(bounds, card, even(40), { bearing: 30, pitch: 45 })!;
    expect(camera.bearing).toBe(30);
    expect(camera.pitch).toBe(45);
    const box = screenBox(camera, card, bounds);
    const touches = [Math.abs(box.left - 40), Math.abs(box.top - 40)];
    expect(Math.min(...touches)).toBeLessThan(1e-6);
    expect(box.left).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(box.top).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(box.left).toBeCloseTo(990 - box.right, 6);
    expect(box.top).toBeCloseTo(424 - box.bottom, 6);
  });

  it("frames a single point at the closest zoom, centred", () => {
    const camera = fitCamera([[13.4, 52.52], [13.4, 52.52]], card, even(33), flat)!;
    expect(camera.zoom).toBe(FIT_MAX_ZOOM);
    expect(camera.lng).toBeCloseTo(13.4, 9);
    expect(camera.lat).toBeCloseTo(52.52, 9);
  });

  it("goes no closer than the limit for a tiny box", () => {
    const camera = fitCamera([[13.4, 52.52], [13.4001, 52.5201]], card, even(33), flat, 12)!;
    expect(camera.zoom).toBe(12);
  });

  it("centres the box in the padded window when the padding is uneven", () => {
    const bounds: Bounds = [[-10, 40], [30, 50]];
    const padding = { top: 20, right: 10, bottom: 80, left: 110 };
    const camera = fitCamera(bounds, card, padding, flat)!;
    const box = screenBox(camera, card, bounds);
    expect((box.left + box.right) / 2).toBeCloseTo((110 + 990 - 10) / 2, 6);
    expect((box.top + box.bottom) / 2).toBeCloseTo((20 + 424 - 80) / 2, 6);
  });

  it("answers nothing when the margin leaves no room", () => {
    expect(fitCamera([[0, 0], [1, 1]], { width: 100, height: 50 }, even(30), flat)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { haversineKm } from "@/lib/geo-measure";
import {
  CIRCLE_SEGMENTS,
  circleRing,
  closeRing,
  rectangleRing,
} from "./draft-geometry";

describe("circleRing — the readout and the stored ring share one distance", () => {
  it("every ring vertex sits at the displayed radius, within rounding", () => {
    // A sub-kilometre radius, where the readout rounds to whole metres —
    // every vertex must sit within half a metre of the displayed value
    // (the flat conversion this replaced drifted ~0.56 m at 500 m).
    const centre: [number, number] = [13.4, 52.5];
    const radiusKm = 0.5;
    const ring = circleRing(centre, radiusKm);
    expect(ring).toHaveLength(CIRCLE_SEGMENTS + 1);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const vertex of ring.slice(0, -1)) {
      const d = haversineKm(centre, vertex);
      expect(Math.abs(d - radiusKm)).toBeLessThan(0.0005);
    }
  });
});

describe("closeRing and rectangleRing", () => {
  it("closes an open ring once and leaves a closed one alone", () => {
    const open: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const closed = closeRing(open);
    expect(closed).toHaveLength(4);
    expect(closeRing(closed)).toHaveLength(4);
  });

  it("builds a closed four-corner ring from two dragged corners", () => {
    const ring = rectangleRing([0, 0], [2, 1]);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring).toContainEqual([2, 0]);
    expect(ring).toContainEqual([0, 1]);
  });
});

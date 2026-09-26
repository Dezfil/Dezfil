import { describe, expect, it } from "vitest";
import {
  haversineKm,
  ringAreaKm2,
  formatDistanceKm,
  formatAreaKm2,
} from "./geo-measure";

describe("haversineKm", () => {
  it("measures one degree of longitude at the equator", () => {
    expect(haversineKm([0, 0], [1, 0])).toBeCloseTo(111.19, 1);
  });

  it("shrinks longitude degrees away from the equator", () => {
    const atEquator = haversineKm([0, 0], [1, 0]);
    const at60 = haversineKm([0, 60], [1, 60]);
    expect(at60).toBeLessThan(atEquator * 0.55);
    expect(at60).toBeGreaterThan(atEquator * 0.45);
  });

  it("is zero for identical points", () => {
    expect(haversineKm([8.68, 50.11], [8.68, 50.11])).toBe(0);
  });
});

describe("ringAreaKm2", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  it("measures a one-degree square at the equator", () => {
    expect(ringAreaKm2(square)).toBeGreaterThan(12_200);
    expect(ringAreaKm2(square)).toBeLessThan(12_500);
  });

  it("accepts closed rings identically", () => {
    expect(ringAreaKm2([...square, square[0]])).toBeCloseTo(
      ringAreaKm2(square),
      6,
    );
  });

  it("is orientation-independent", () => {
    expect(ringAreaKm2([...square].reverse())).toBeCloseTo(
      ringAreaKm2(square),
      6,
    );
  });

  it("returns zero under three distinct points", () => {
    expect(ringAreaKm2([])).toBe(0);
    expect(
      ringAreaKm2([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(0);
    expect(
      ringAreaKm2([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    ).toBe(0);
  });
});

describe("formatting (rounded, meters below 1)", () => {
  it("rounds distances to whole kilometres", () => {
    expect(formatDistanceKm(391.9)).toBe("392 km");
    expect(formatDistanceKm(1234.4)).toBe("1,234 km");
  });

  it("switches distances below 1 km to meters", () => {
    expect(formatDistanceKm(0.83)).toBe("830 m");
    expect(formatDistanceKm(0.0004)).toBe("0 m");
  });

  it("rounds areas to whole square kilometres", () => {
    expect(formatAreaKm2(77_089.88)).toBe("77,090 km²");
    expect(formatAreaKm2(1.4)).toBe("1 km²");
  });

  it("switches areas below 1 km² to square meters", () => {
    expect(formatAreaKm2(0.0043)).toBe("4,300 m²");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bezelFor, cornerFor, displacementField, edgeDistance, edgeNormal, shiftFor, surfaceBend } from "./lens-maths";

/**
 * The lens of a liquid panel, as numbers: the distance field of a rounded
 * rectangle, its edge's normal, the bend across the bezel and the baked
 * displacement map. Every expected value is worked out here by hand.
 */

describe("the lens maths", () => {
  it("measures how far a point lies inside a rounded rectangle from its edge", () => {
    expect(edgeDistance(50, 25, 100, 50, 10)).toBeCloseTo(25);
    expect(edgeDistance(100, 25, 100, 50, 10)).toBeCloseTo(0);
    expect(edgeDistance(101, 25, 100, 50, 10)).toBeCloseTo(-1);
    expect(edgeDistance(90, 25, 100, 50, 10)).toBeCloseTo(10);
    // The corner's own point lies outside the rounded corner by √200 − 10.
    expect(edgeDistance(0, 0, 100, 50, 10)).toBeCloseTo(10 - Math.SQRT2 * 10);
    // On the corner's arc: the centre (10, 10), 10 out along the diagonal.
    expect(edgeDistance(10 - Math.SQRT1_2 * 10, 10 - Math.SQRT1_2 * 10, 100, 50, 10)).toBeCloseTo(0);
  });

  it("finds the edge's outward normal", () => {
    const [rx, ry] = edgeNormal(99.5, 25, 100, 50, 10);
    expect(rx).toBeCloseTo(1);
    expect(ry).toBeCloseTo(0);
    const [tx, ty] = edgeNormal(50, 0.5, 100, 50, 10);
    expect(tx).toBeCloseTo(0);
    expect(ty).toBeCloseTo(-1);
    const [cx, cy] = edgeNormal(97, 47, 100, 50, 10);
    expect(cx).toBeCloseTo(Math.SQRT1_2);
    expect(cy).toBeCloseTo(Math.SQRT1_2);
  });

  it("bends a ray most at the edge and not at all where the surface flattens, at an index of 1.5", () => {
    expect(surfaceBend(0)).toBe(0);
    // At the edge the slope is read at 0.96: asin(0.96) less its refraction asin(0.96 / 1.5).
    expect(surfaceBend(1)).toBeCloseTo(Math.tan(Math.asin(0.96) - Math.asin(0.64)), 10);
    expect(surfaceBend(1)).toBeCloseTo(0.6732, 3);
    expect(surfaceBend(2)).toBe(surfaceBend(1));
    expect(surfaceBend(0.5)).toBeCloseTo(Math.tan(Math.asin(0.5) - Math.asin(1 / 3)), 10);
    expect(surfaceBend(0.25)).toBeLessThan(surfaceBend(0.5));
  });

  it("sizes the bezel, the pull and the corner for the surface", () => {
    expect(bezelFor(400, 900)).toBe(14);
    expect(bezelFor(200, 30)).toBe(10);
    expect(bezelFor(9, 9)).toBe(4);
    // The header's 38 px buttons pull 9.5 px, a quarter of their side, not the role's 20.
    expect(shiftFor(20, 38, 38)).toBe(9.5);
    expect(shiftFor(18, 400, 900)).toBe(18);
    expect(shiftFor(12, 8, 8)).toBe(3);
    expect(cornerFor(12, 200, 40)).toBe(12);
    expect(cornerFor(999, 120, 30)).toBe(15);
    expect(cornerFor(10.3, 200, 40)).toBe(10.5);
    expect(cornerFor(-4, 200, 40)).toBe(0);
  });

  it("bakes a map that pulls the backdrop inward across the bezel and leaves the middle neutral", () => {
    const w = 60, h = 40, field = displacementField(w, h, 8);
    expect(field).toHaveLength(w * h * 4);
    const at = (x: number, y: number) => Array.from(field.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
    // Blue is unused and alpha opaque throughout.
    for (let i = 0; i < w * h; i += 1) {
      expect(field[i * 4 + 2]).toBe(128);
      expect(field[i * 4 + 3]).toBe(255);
    }
    // The middle, past the bezel and the blur's reach, does not move.
    expect(at(30, 20)).toEqual([128, 128, 128, 255]);
    // The right edge samples from the left (red under 128), the left edge
    // from the right, the top from below (green over 128), the bottom from above.
    const right = at(58, 20), left = at(1, 20), top = at(30, 1), bottom = at(30, 38);
    expect(right[0]).toBeLessThan(80);
    expect(left[0]).toBeGreaterThan(176);
    expect(top[1]).toBeGreaterThan(176);
    expect(bottom[1]).toBeLessThan(80);
    expect(right[1]).toBe(128);
    expect(top[0]).toBe(128);
    // Mirrored sides pull alike.
    expect(right[0] + left[0]).toBeGreaterThanOrEqual(255);
    expect(right[0] + left[0]).toBeLessThanOrEqual(257);
    // The pull fades inward and is gone past the bezel.
    const pull = (x: number) => Math.abs(at(x, 20)[0] - 128);
    expect(pull(56)).toBeGreaterThan(pull(52));
    expect(pull(52)).toBeGreaterThan(pull(48));
    expect(pull(40)).toBe(0);
  });

  it("keeps liquid-dom's copyright and permission notice in the file that carries the maths", () => {
    const source = readFileSync("src/components/look/lens-maths.ts", "utf8");
    expect(source).toContain("liquid-dom");
    expect(source).toContain("Copyright (c) 2026 Andras Prifer");
    expect(source).toContain("The above copyright notice and this permission notice shall be included in all");
    const notice = readFileSync("NOTICE", "utf8");
    expect(notice).toMatch(/liquid-dom \(MIT, © 2026 Andras Prifer[^)]*\)[\s\S]*?src\/components\/look\/lens-maths\.ts/);
  });
});

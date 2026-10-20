import { expect, it } from "vitest";
import { edgeRise } from "../../../test-support/edge-rise";

/** A hard edge at a fractional position, sampled with box averaging at a
 * given number of samples per unit, the way a screen samples it. */
function sampled(perUnit: number, edgeAt = 20.37, length = 40) {
  return Array.from({ length: length * perUnit }, (_, i) => {
    const from = i / perUnit, to = (i + 1) / perUnit;
    const share = Math.min(1, Math.max(0, (to - edgeAt) / (to - from)));
    return 40 + 200 * share;
  });
}
/** The same edge drawn small and enlarged by `factor` with linear filtering. */
function enlarged(factor: number, edgeAt: number) {
  const small = sampled(1, edgeAt, 14);
  return Array.from({ length: small.length * factor }, (_, i) => {
    const x = (i + 0.5) / factor - 0.5, left = Math.max(0, Math.floor(x)), right = Math.min(small.length - 1, left + 1), t = Math.min(1, Math.max(0, x - left));
    return small[left] * (1 - t) + small[right] * t;
  });
}
const positions = [0, 0.1, 0.25, 0.5, 0.75, 0.9];

it("measures a hard edge, wherever it falls in a pixel, within the two-pixel bound", () => {
  for (const at of positions) {
    expect(edgeRise(sampled(1, 20 + at))).toBeLessThanOrEqual(1.6 + 1e-9);
    expect(edgeRise(sampled(1, 20 + at).reverse())).toBeLessThanOrEqual(1.6 + 1e-9);
  }
});

it("measures the same edge enlarged threefold past the bound, wherever it falls", () => {
  for (const at of positions) expect(edgeRise(enlarged(3, 6 + at))).toBeGreaterThan(2);
});

it("refuses a line that crosses no edge", () => {
  expect(() => edgeRise(Array.from({ length: 30 }, () => 128))).toThrow("no edge");
});

import { describe, it, expect } from "vitest";
import type { LayerStyle } from "@/lib/style/style";
import type { LayerViz } from "@/lib/viz";
import { pinMarksForSpace } from "./pin-marks";
import { REFERENCE_SPACE_WIDTH, densityFor } from "./space";

/** Sample space widths for the width-based mark rule — the 4:3
 * derivations of the four steps, fixed here as literals moved the live
 * step table to short sides while marks deliberately stayed
 * width-anchored. */
const SAMPLE_SPACES = { xs: 1920, s: 1440, m: 1080, l: 720 } as const;

/**
 * The field round's third directive: a data mark's share of the exported
 * image is the author's styling, not a side effect of the basemap's
 * fineness. The identity is the overlays' own: pinned pixels × density
 * is constant across spaces.
 */

const baseStyle: LayerStyle = {
  fill: { type: "constant", color: { r: 13, g: 125, b: 92, a: 1 } },
  fillOpacity: 1,
  stroke: { r: 255, g: 255, b: 255, a: 1 },
  strokeOpacity: 1,
  strokeWidth: 2,
  pointRadius: 6,
  opacity: 1,
  pointRadiusBy: {
    attribute: "riders",
    domain: [0, 100],
    range: [4, 18],
  },
  strokeWidthBy: {
    attribute: "riders",
    domain: [0, 100],
    range: [1, 5],
  },
  label: {
    attribute: "name",
    size: 12,
    color: { r: 36, g: 50, b: 48, a: 1 },
    haloWidth: 1, haloColor: { r: 12, g: 16, b: 24, a: 0.8 },
  },
};

const layer = (viz?: LayerViz) => ({ style: baseStyle, viz });

const OUTPUT = 1920;

/** A pinned pixel channel's size in the OUTPUT: composition px × density. */
function outputPx(compositionPx: number, spaceWidth: number): number {
  return compositionPx * densityFor(OUTPUT, spaceWidth);
}

describe("data marks keep their share of the image", () => {
  it("every pixel channel is invariant across the map-size steps", () => {
    const spaces = Object.values(SAMPLE_SPACES);
    const reference = pinMarksForSpace([layer()], spaces[0])[0];
    for (const space of spaces) {
      const [pinned] = pinMarksForSpace([layer()], space);
      const pairs: Array<[number, number]> = [
        [pinned.style.pointRadius, reference.style.pointRadius],
        [pinned.style.strokeWidth, reference.style.strokeWidth],
        [pinned.style.pointRadiusBy!.range[0], reference.style.pointRadiusBy!.range[0]],
        [pinned.style.pointRadiusBy!.range[1], reference.style.pointRadiusBy!.range[1]],
        [pinned.style.strokeWidthBy!.range[1], reference.style.strokeWidthBy!.range[1]],
        [pinned.style.label!.size, reference.style.label!.size],
      ];
      for (const [value, ref] of pairs) {
        expect(outputPx(value, space)).toBeCloseTo(
          outputPx(ref, Object.values(SAMPLE_SPACES)[0]),
          9,
        );
      }
    }
  });

  it("pins the heatmap's kernel, and deliberately NOT the cluster radius", () => {
    const heat: LayerViz = {
      type: "heatmap",
      radiusPx: 30,
      intensity: 1,
      weight: null,
    };
    const cluster: LayerViz = {
      type: "cluster",
      radiusPx: 64,
      color: "fixed",
      showCounts: true,
    };
    for (const space of Object.values(SAMPLE_SPACES)) {
      const [h, c] = pinMarksForSpace([layer(heat), layer(cluster)], space);
      expect(outputPx((h.viz as typeof heat).radiusPx, space)).toBeCloseTo(
        outputPx(30, 720),
        9,
      );
      // The cluster radius stays the author's number: the index is
      // queried at integer zooms, so a continuously scaled radius
      // against a floored query CHANGED the grouping at fractional
      // compensations. Parity lives in the canvas's
      // logical cluster zoom — visual zoom minus the space's
      // compensation — which lands on exactly the reference grouping.
      expect((c.viz as typeof cluster).radiusPx).toBe(64);
    }
  });

  it("does not scale an aggregated layer's label — meters are ground-anchored", () => {
    // Cells label in ground meters, which the space change already
    // leaves alone; scaling the source size grew cell labels ×2.67 at
    // the default step.
    const hex: LayerViz = {
      type: "hexbin",
      cellKm: 1.2,
      aggregate: { fn: "count" },
    };
    const [pinned] = pinMarksForSpace([layer(hex)], SAMPLE_SPACES.xs);
    expect(pinned.style.label!.size).toBe(12);
    // ...while a pixel-labeled layer's text is pinned as before.
    const [points] = pinMarksForSpace([layer()], SAMPLE_SPACES.xs);
    expect(points.style.label!.size).toBeCloseTo(12 * (1920 / 720), 9);
  });

  it("leaves ground-anchored geometry alone", () => {
    const hex: LayerViz = {
      type: "hexbin",
      cellKm: 1.2,
      aggregate: { fn: "count" },
    };
    const [pinned] = pinMarksForSpace([layer(hex)], SAMPLE_SPACES.xs);
    expect((pinned.viz as { cellKm: number }).cellKm).toBe(1.2);
  });

  it("is the identity at the calibration space, and never mutates", () => {
    const input = [layer()];
    const out = pinMarksForSpace(input, 720);
    expect(out[0].style.pointRadius).toBe(6);
    const fine = pinMarksForSpace(input, SAMPLE_SPACES.xs);
    expect(fine[0].style.pointRadius).not.toBe(6);
    // The input objects are untouched — the card's stage is shared state.
    expect(input[0].style.pointRadius).toBe(6);
    expect(input[0].style.pointRadiusBy!.range).toEqual([4, 18]);
  });
});

describe("the label channels under the space factor", () => {
  it("offset rides the factor like size; halo width never does", () => {
    const withOffset = {
      style: {
        ...baseStyle,
        label: {
          ...baseStyle.label!,
          haloWidth: 0.6,
          offsetX: 10,
          offsetY: -8,
        },
      },
      viz: undefined,
    };
    const wide = SAMPLE_SPACES.xs * 2;
    const f = wide / REFERENCE_SPACE_WIDTH;
    const pinned = pinMarksForSpace([withOffset], wide)[0] as unknown as {
      style: { label: Record<string, number> };
    };
    expect(pinned.style.label.size).toBe(12 * f);
    expect(pinned.style.label.offsetX).toBe(10 * f);
    expect(pinned.style.label.offsetY).toBe(-8 * f);
    expect(pinned.style.label.haloWidth).toBe(0.6);
  });
});

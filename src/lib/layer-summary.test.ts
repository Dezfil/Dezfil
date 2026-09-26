import { describe, expect, it } from "vitest";
import { layerSwatch } from "./layer-summary";
import type { LayerStyle, RgbaColor } from "@/lib/style/style";
import type { LayerViz } from "@/lib/viz";

const c = (r: number, g: number, b: number): RgbaColor => ({ r, g, b, a: 1 });
const css = (x: RgbaColor) => `rgba(${x.r}, ${x.g}, ${x.b}, ${x.a})`;

const RED = c(200, 30, 30);
const GRAY = c(120, 120, 120);

/** A five-class dark-to-yellow ramp — the hexbin shape from the field. */
const RAMP = [c(40, 0, 60), c(120, 20, 60), c(200, 60, 40), c(240, 140, 40), c(250, 220, 80)];

const base: LayerStyle = {
  fill: { type: "constant", color: RED },
  fillOpacity: 1,
  stroke: GRAY,
  strokeOpacity: 1,
  strokeWidth: 1,
  pointRadius: 4,
  opacity: 1,
};

const points: LayerViz = { type: "points" };

describe("layerSwatch — the swatch is the drawn thing (2026-08-10 field find)", () => {
  // The defect: the export menu read the STORED style, but an aggregated
  // layer draws its cells with the viz fill — effectiveStyle's projection.
  it("shows a hexbin's viz ramp, not the stored point fill", () => {
    const hexbin: LayerViz = {
      type: "hexbin",
      cellKm: 1,
      aggregate: { fn: "count" },
      fill: {
        type: "quantile",
        attribute: "value",
        palette: "inferno",
        colors: RAMP,
        breaks: [1, 2, 3, 6],
      },
    };
    const swatch = layerSwatch(base, hexbin);
    expect(swatch.colors).toEqual(RAMP.map(css));
    expect(swatch.colors).not.toContain(css(RED));
    expect(swatch.ramp).toBe(true);
  });

  it("falls back to the stored fill while a hexbin's ramp is unassigned", () => {
    const bare: LayerViz = { type: "hexbin", cellKm: 1, aggregate: { fn: "count" } };
    expect(layerSwatch(base, bare)).toEqual({ colors: [css(RED)], ramp: false });
  });

  // The second defect: a cap at four colors showed a long ramp as its
  // bottom end. Every class color survives, in order.
  it("returns every class color of a long ramp, in order", () => {
    const six = [...RAMP, c(255, 255, 200)];
    const style: LayerStyle = {
      ...base,
      fill: {
        type: "continuous",
        attribute: "rating",
        palette: "ylorrd",
        domain: [0, 5],
        stops: six,
      },
    };
    expect(layerSwatch(style, points).colors).toEqual(six.map(css));
  });

  it("shows a constant fill as one color, not a ramp", () => {
    expect(layerSwatch(base, points)).toEqual({
      colors: [css(RED)],
      ramp: false,
    });
  });
});

describe("layerSwatch — the drawn channel", () => {
  // Lines and arcs draw their visible color from the stroke channel — a
  // fill-only swatch showed a stale color.
  it("reads a line layer from its stroke channel", () => {
    const line: LayerViz = { type: "line", origin: null, dest: null, height: 0 };
    const style: LayerStyle = {
      ...base,
      strokeBy: {
        type: "categorical",
        attribute: "kind",
        palette: "set2",
        map: [
          { value: "a", color: RAMP[0] },
          { value: "b", color: RAMP[1] },
        ],
        other: GRAY,
      },
    };
    expect(layerSwatch(style, line).colors).toEqual([
      css(RAMP[0]),
      css(RAMP[1]),
    ]);
  });

  it("reads an unstyled line layer's constant stroke", () => {
    const line: LayerViz = { type: "line", origin: null, dest: null, height: 0 };
    expect(layerSwatch(base, line)).toEqual({
      colors: [css(GRAY)],
      ramp: false,
    });
  });

  // The old fallback for an empty data-driven fill was an invented green;
  // the spine's fallback is the layer's own stroke.
  it("falls back to the stroke for an empty class map, never an invented color", () => {
    const style: LayerStyle = {
      ...base,
      fill: {
        type: "categorical",
        attribute: "kind",
        palette: "set2",
        map: [],
        other: GRAY,
      },
    };
    expect(layerSwatch(style, points)).toEqual({
      colors: [css(GRAY)],
      ramp: false,
    });
  });
});

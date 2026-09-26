import { describe, it, expect } from "vitest";
import {
  styleProblem,
  representativeColor,
  type ContinuousFill,
  type LayerStyle,
  type RgbaColor,
} from "./style";
import { defaultStyle } from "./defaults";
import {
  sampleRamp,
  rampColors,
  continuousStops,
  RAMP_ALPHA,
} from "./palettes";
import {
  fillAccessor,
  continuousPosition,
  opaqueFillPaint,
} from "./deck-style";
import { legendFor } from "./legend";

const c = (r: number, g: number, b: number, a = 0.82): RgbaColor => ({
  r,
  g,
  b,
  a,
});

const ramp = (over: Partial<ContinuousFill> = {}): ContinuousFill => ({
  type: "continuous",
  attribute: "pop",
  palette: "viridis",
  domain: [0, 100],
  stops: [c(0, 0, 0), c(100, 100, 100), c(200, 200, 200)],
  ...over,
});

const styled = (fill: ContinuousFill): LayerStyle => ({
  ...defaultStyle("POINT", 0),
  fill,
});

describe("continuous fill validation", () => {
  it("accepts a well-formed continuous paint", () => {
    expect(styleProblem(styled(ramp()))).toBeNull();
    expect(
      styleProblem(
        styled(
          ramp({
            clamp: [10, 90],
            log: true,
            center: 50,
            reversed: true,
            positions: [0, 0.3, 1],
          }),
        ),
      ),
    ).toBeNull();
  });

  it("rejects malformed shapes with an explanation", () => {
    expect(styleProblem(styled(ramp({ stops: [c(0, 0, 0)] })))).toMatch(
      /malformed continuous/,
    );
    expect(
      styleProblem(styled(ramp({ domain: [10, 0] }))),
    ).toMatch(/low to high/);
  });

  it("rejects a clamp outside the domain or inverted", () => {
    expect(styleProblem(styled(ramp({ clamp: [90, 10] })))).toMatch(/clamp/);
    expect(styleProblem(styled(ramp({ clamp: [-5, 50] })))).toMatch(/clamp/);
    expect(styleProblem(styled(ramp({ clamp: [0, 101] })))).toMatch(/clamp/);
  });

  it("rejects log over a non-positive effective domain, accepts it clamped positive", () => {
    expect(styleProblem(styled(ramp({ log: true })))).toMatch(/positive/);
    expect(
      styleProblem(styled(ramp({ log: true, clamp: [1, 90] }))),
    ).toBeNull();
  });

  it("rejects a center outside the effective domain", () => {
    expect(styleProblem(styled(ramp({ center: 200 })))).toMatch(/center/);
    expect(
      styleProblem(styled(ramp({ clamp: [20, 80], center: 10 }))),
    ).toMatch(/center/);
    expect(styleProblem(styled(ramp({ center: 50 })))).toBeNull();
  });

  it("rejects positions that mismatch the stops or descend", () => {
    expect(styleProblem(styled(ramp({ positions: [0, 1] })))).toMatch(
      /positions/,
    );
    expect(
      styleProblem(styled(ramp({ positions: [0, 0.9, 0.4] }))),
    ).toMatch(/positions/);
  });
});

describe("sampleRamp", () => {
  const stops = [c(0, 0, 0), c(100, 100, 100), c(200, 200, 200)];

  it("interpolates evenly spaced stops", () => {
    expect(sampleRamp(stops, undefined, 0).r).toBe(0);
    expect(sampleRamp(stops, undefined, 0.5).r).toBe(100);
    expect(sampleRamp(stops, undefined, 1).r).toBe(200);
    expect(sampleRamp(stops, undefined, 0.25).r).toBe(50);
  });

  it("honors explicit positions", () => {
    const p = sampleRamp(stops, [0, 0.8, 1], 0.4);
    expect(p.r).toBe(50); // halfway through the wide first segment
  });

  it("clamps outside 0–1 and treats equal positions as a hard step", () => {
    expect(sampleRamp(stops, undefined, -1).r).toBe(0);
    expect(sampleRamp(stops, undefined, 2).r).toBe(200);
    const hard = sampleRamp(stops, [0, 0.5, 0.5], 0.75);
    expect(hard.r).toBe(200);
  });

  it("draws k classes from explicit stops for classified use", () => {
    const colors = rampColors(stops, undefined, 3);
    expect(colors.map((x) => x.r)).toEqual([0, 100, 200]);
  });
});

describe("continuous accessor", () => {
  const f = (v: unknown) => ({ properties: { pop: v } });
  const rgb = (
    a: ReturnType<typeof fillAccessor>,
    v: unknown,
  ): [number, number, number] => {
    const fn = a as (x: { properties: Record<string, unknown> }) => number[];
    const [r, g, b] = fn(f(v) as { properties: Record<string, unknown> });
    return [r, g, b];
  };

  it("maps min and max onto the ramp ends and interpolates between", () => {
    const a = fillAccessor(ramp(), 1);
    expect(rgb(a, 0)[0]).toBe(0);
    expect(rgb(a, 100)[0]).toBe(200);
    expect(rgb(a, 50)[0]).toBeGreaterThan(90);
    expect(rgb(a, 50)[0]).toBeLessThan(110);
  });

  it("clamps values outside the clamp window to the end colors", () => {
    const a = fillAccessor(ramp({ clamp: [20, 80] }), 1);
    expect(rgb(a, 0)).toEqual(rgb(a, 20));
    expect(rgb(a, 100)).toEqual(rgb(a, 80));
  });

  it("log scaling separates the low end of a skewed field", () => {
    const linear = continuousPosition(ramp({ domain: [1, 10000] }));
    const logged = continuousPosition(
      ramp({ domain: [1, 10000], log: true }),
    );
    expect(linear(10)).toBeLessThan(0.01);
    expect(logged(10)).toBeCloseTo(0.25, 2);
  });

  it("pins the center to the ramp midpoint for diverging reads", () => {
    const pos = continuousPosition(ramp({ center: 20 }));
    expect(pos(20)).toBeCloseTo(0.5, 2);
    expect(pos(10)).toBeCloseTo(0.25, 2);
    expect(pos(60)).toBeCloseTo(0.75, 2);
  });

  it("draws missing and non-numeric values at the low end", () => {
    const a = fillAccessor(ramp(), 1);
    expect(rgb(a, undefined)).toEqual(rgb(a, 0));
    expect(rgb(a, "not a number")).toEqual(rgb(a, 0));
  });

  it("collapsed domains draw the low end instead of dividing by zero", () => {
    const a = fillAccessor(ramp({ domain: [5, 5] }), 1);
    expect(rgb(a, 5)).toEqual(rgb(a, 99));
  });
});

describe("continuous paint plumbing", () => {
  it("opaqueFillPaint solidifies the stops", () => {
    const solid = opaqueFillPaint(ramp());
    expect(
      (solid as ContinuousFill).stops.every((s) => s.a === 1),
    ).toBe(true);
  });

  it("representativeColor picks the middle stop", () => {
    expect(representativeColor(styled(ramp())).r).toBe(100);
  });

  it("continuousStops resolves the catalogue at the ramp alpha", () => {
    const stops = continuousStops("viridis");
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops.every((s) => s.a === RAMP_ALPHA)).toBe(true);
    const reversedStops = continuousStops("viridis", true);
    expect(reversedStops[0]).toEqual(stops[stops.length - 1]);
  });
});

describe("continuous legend channel", () => {
  it("emits a ramp with effective-domain labels", () => {
    const legend = legendFor(styled(ramp()));
    const fill = legend?.paints[0];
    expect(fill?.kind).toBe("continuous");
    expect(fill?.entries).toEqual([]);
    expect(fill?.ramp?.labels).toEqual(["0", "100"]);
  });

  it("marks clamped ends as open and shows the center", () => {
    const legend = legendFor(
      styled(ramp({ clamp: [20, 80], center: 50 })),
    );
    const rampBlock = legend?.paints[0]?.ramp;
    expect(rampBlock?.labels).toEqual(["≤ 20", "≥ 80"]);
    expect(rampBlock?.center).toBe("50");
  });
});

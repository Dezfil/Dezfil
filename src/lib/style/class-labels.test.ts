// The automatic text of a classed paint's classes. A value on a break
// belongs to the lower class, as the map's own colouring places it, so the
// first class reads "≤ b" and the last "> b"; the classes between share
// their boundaries ("1 – 2"), the usual map shorthand. The seeded defect
// is the text these replaced: "< 1" on a class that holds 1, and "≥ 3" on
// a class that cannot hold 3.
import { describe, expect, it } from "vitest";
import { classLabels, formatBreak } from "./class-labels";
import { fillAccessor } from "./deck-style";
import { legendFor } from "./legend";
import { defaultStyle } from "./defaults";
import type { QuantileFill } from "./style";

function paint(breaks: number[]): QuantileFill {
  return {
    type: "quantile",
    attribute: "v",
    palette: "global_warming",
    method: "quantile",
    breaks,
    // One colour per class, told apart by red alone.
    colors: Array.from({ length: breaks.length + 1 }, (_, i) => ({
      r: i,
      g: 0,
      b: 0,
      a: 1,
    })),
  };
}

const texts = (breaks: number[]) => classLabels(paint(breaks)).map((l) => l.text);

/** Which class the map's colouring draws a value in. */
function drawnClass(p: QuantileFill, v: number): number {
  const accessor = fillAccessor(p) as (f: { properties: Record<string, unknown> }) => number[];
  return accessor({ properties: { v } })[0];
}

/** Whether a threshold-form text admits a value: "≤ b", "> b", or the
 * shared-boundary range "a – b" holding a < v ≤ b. The numbers are read
 * back from the text, so a formatter that loses digits fails here too. */
function admits(text: string, v: number): boolean {
  const num = (s: string) => Number(s.replace(/,/g, ""));
  if (text.startsWith("≤ ")) return v <= num(text.slice(2));
  if (text.startsWith("> ")) return v > num(text.slice(2));
  const [a, b] = text.split(" – ");
  return v > num(a) && v <= num(b);
}

describe("class labels, threshold form", () => {
  it("reads breaks 1, 2, 3 as what each class can hold", () => {
    expect(texts([1, 2, 3])).toEqual(["≤ 1", "1 – 2", "2 – 3", "> 3"]);
    expect(texts([1, 2, 3])).not.toContain("< 1");
    expect(texts([1, 2, 3])).not.toContain("≥ 3");
  });

  it("reads natural breaks 4, 14, 27, 42 with open outer ends", () => {
    expect(texts([4, 14, 27, 42])).toEqual([
      "≤ 4",
      "4 – 14",
      "14 – 27",
      "27 – 42",
      "> 42",
    ]);
  });

  it("a constant column's one break gives two outer labels", () => {
    expect(texts([5])).toEqual(["≤ 5", "> 5"]);
  });

  it("negative and fractional breaks keep their sign and digits", () => {
    expect(texts([-2.5, 0, 12.5])).toEqual(["≤ -2.5", "-2.5 – 0", "0 – 12.5", "> 12.5"]);
  });

  it("splits each bounded class around its upper boundary for the panel", () => {
    const labels = classLabels(paint([1, 2, 3]));
    expect(labels.map((l) => l.lead)).toEqual(["≤", "1 –", "2 –", undefined]);
    labels.slice(0, -1).forEach((l, i) =>
      expect(l.text).toBe(`${l.lead} ${formatBreak([1, 2, 3][i])}`),
    );
  });

  it("agrees with where the map's colouring puts every value", () => {
    const cases = [
      [1, 2, 3],
      [4, 14, 27, 42],
      [5],
      [-2.5, 0, 12.5],
      [0.000012345, 0.000012346],
      [0.1 + 0.2, 0.30000000000000016],
      [9_007_199_254_740_000, 9_007_199_254_740_991],
    ];
    for (const breaks of cases) {
      const p = paint(breaks);
      const labels = classLabels(p).map((l) => l.text);
      const probes = breaks.flatMap((b, i) => {
        const next = breaks[i + 1];
        return [
          b,
          b - Math.abs(b) * 1e-9 - 1e-12,
          next === undefined ? b + Math.abs(b) + 1 : (b + next) / 2,
        ];
      });
      for (const v of probes) {
        const drawn = drawnClass(p, v);
        const admitting = labels.flatMap((t, i) => (admits(t, v) ? [i] : []));
        expect(admitting, `${v} under ${labels.join(" | ")}`).toEqual([drawn]);
      }
    }
  });

  it("is what every legend surface reads, through legendFor", () => {
    const style = { ...defaultStyle("POINT"), fill: paint([1, 2, 3]) };
    expect(legendFor(style)?.paints[0].entries.map((e) => e.label)).toEqual([
      "≤ 1",
      "1 – 2",
      "2 – 3",
      "> 3",
    ]);
  });

  it("has no em dash in any automatic text", () => {
    for (const breaks of [[1, 2, 3], [-1e-7, 0], [1e21, 1e22]]) {
      for (const t of texts(breaks)) expect(t).not.toContain("—");
    }
  });
});

describe("the boundary formatter keeps a break's value", () => {
  it("groups thousands and keeps decimals as stored", () => {
    expect(formatBreak(16890)).toBe("16,890");
    expect(formatBreak(12.5)).toBe("12.5");
    expect(formatBreak(243.1755)).toBe("243.1755");
    expect(formatBreak(-1234567.25)).toBe("-1,234,567.25");
    expect(formatBreak(0)).toBe("0");
  });

  it("reads micro magnitudes as exponents with every digit they need", () => {
    expect(formatBreak(0.0000125)).toBe("1.25e-5");
    expect(formatBreak(0.000012345678)).toBe("1.2345678e-5");
    expect(formatBreak(-0.00002)).toBe("-2e-5");
  });

  it("never turns two different numbers into one text", () => {
    const pairs: [number, number][] = [
      [0.000012345, 0.000012346],
      [1.234561e-5, 1.234562e-5],
      [0.123456789012, 0.123456789013],
      [0.1 + 0.2, 0.3],
      [9_007_199_254_740_990, 9_007_199_254_740_991],
      [1e21, 1e21 + 1e6],
    ];
    for (const [a, b] of pairs) {
      expect(a).not.toBe(b);
      expect(formatBreak(a)).not.toBe(formatBreak(b));
    }
  });

  it("reads back as the very number it shows", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const values = [
      ...Array.from({ length: 200 }, () => (random() - 0.5) * 10 ** Math.floor(random() * 30 - 12)),
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      1e-4,
      9.99e-5,
      123456789.12345679,
    ];
    for (const v of values) {
      expect(Number(formatBreak(v).replace(/,/g, ""))).toBe(v);
    }
  });
});

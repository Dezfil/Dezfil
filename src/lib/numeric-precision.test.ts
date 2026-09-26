import { describe, expect, it } from "vitest";
import {
  decimalsFor,
  exactText,
  formatBound,
  isIntegerColumn,
  resolutionFor,
  snap,
  stepFor,
} from "./numeric-precision";

describe("integer columns are read from the declared type", () => {
  it("recognises DuckDB's integer family", () => {
    for (const t of [
      "INTEGER",
      "BIGINT",
      "SMALLINT",
      "TINYINT",
      "HUGEINT",
      "UBIGINT",
      "UINTEGER",
      "int",
    ]) {
      expect(isIntegerColumn(t)).toBe(true);
    }
  });

  it("does not mistake the floating-point family for it", () => {
    for (const t of ["DOUBLE", "FLOAT", "REAL", "DECIMAL(10,2)", "VARCHAR"]) {
      expect(isIntegerColumn(t)).toBe(false);
    }
  });

  it("treats an unknown type as floating point", () => {
    expect(isIntegerColumn(undefined)).toBe(false);
  });
});

// The four extents names, with their expected resolution — so a wrong
// rule fails here rather than passing by enumerating whatever it happens
// to produce.
describe("the named extents resolve as the spec says", () => {
  it("an integer column over 0–45 steps by 1 at 0 decimals", () => {
    expect(resolutionFor(0, 45, "INTEGER")).toEqual({ step: 1, decimals: 0 });
  });

  it("a float column over 0–1 steps by 0.005 at 3 decimals", () => {
    expect(resolutionFor(0, 1, "DOUBLE")).toEqual({
      step: 0.005,
      decimals: 3,
    });
  });

  it("a float column over 0–19.99 steps by 0.05 at 2 decimals", () => {
    expect(resolutionFor(0, 19.99, "DOUBLE")).toEqual({
      step: 0.05,
      decimals: 2,
    });
  });

  it("a float column over 0–1,250,000 steps by 5,000 at 0 decimals", () => {
    expect(resolutionFor(0, 1_250_000, "DOUBLE")).toEqual({
      step: 5000,
      decimals: 0,
    });
  });
});

describe("degenerate extents stay finite", () => {
  it("survives a zero span", () => {
    expect(Number.isFinite(stepFor(7, 7, "DOUBLE"))).toBe(true);
    expect(stepFor(7, 7, "INTEGER")).toBe(1);
  });

  it("survives a reversed extent", () => {
    expect(stepFor(45, 0, "INTEGER")).toBe(1);
  });

  it("never steps an integer column below 1", () => {
    // A two-hundredth of this span is 0.03 — a fractional step on a column
    // that cannot hold fractions.
    expect(stepFor(0, 6, "BIGINT")).toBe(1);
    expect(decimalsFor(stepFor(0, 6, "BIGINT"))).toBe(0);
  });

  it("keeps enough decimals for a very small extent", () => {
    const r = resolutionFor(0, 0.0001, "DOUBLE");
    expect(r.step).toBeGreaterThan(0);
    // The step must be renderable at the decimals it reports.
    expect(Number(r.step.toFixed(r.decimals))).toBe(r.step);
  });
});

describe("every reachable position is exact and distinct", () => {
  const EXTENTS: [number, number, string][] = [
    [0, 45, "INTEGER"],
    [0, 1, "DOUBLE"],
    [0, 19.99, "DOUBLE"],
    [0, 1_250_000, "DOUBLE"],
    [-3.5, 3.5, "DOUBLE"],
    [1000, 1001, "DOUBLE"],
  ];

  for (const [min, max, type] of EXTENTS) {
    it(`${type} over ${min}–${max}: no float tails, no repeats`, () => {
      const res = resolutionFor(min, max, type);
      const seen = new Set<string>();
      let previous: number | null = null;
      for (let v = min; v <= max; v = v + res.step) {
        const value = snap(v, res);
        const text = formatBound(value, res);

        // What the readout prints is exactly the number that is stored:
        // parsing the text back gives the value itself.
        expect(Number(text)).toBe(value);

        // No 0.30000000000000004 tails: the value needs no more decimals
        // than the step does.
        expect(value.toFixed(res.decimals)).toBe(text);

        // Adjacent positions never read the same.
        if (previous !== null && value !== previous) {
          expect(seen.has(text)).toBe(false);
        }
        seen.add(text);
        previous = value;
      }
      expect(seen.size).toBeGreaterThan(1);
    });
  }

  it("spends the float tail a naive snap would leave", () => {
    const res = resolutionFor(0, 1, "DOUBLE"); // step 0.005
    // 0.1 + 0.2 is the canonical tail; snapping must not carry it through.
    expect(snap(0.1 + 0.2, res)).toBe(0.3);
    expect(formatBound(snap(0.1 + 0.2, res), res)).toBe("0.300");
  });

  it("snaps an off-step value to the nearest position", () => {
    const res = resolutionFor(0, 45, "INTEGER");
    expect(snap(12.4, res)).toBe(12);
    expect(snap(12.6, res)).toBe(13);
  });

  it("renders the extent's zero without a sign", () => {
    const res = resolutionFor(-3.5, 3.5, "DOUBLE");
    expect(formatBound(snap(-0.0000001, res), res)).not.toContain("-");
  });
});

describe("decimalsFor", () => {
  it("reads the decimals a step needs", () => {
    expect(decimalsFor(1)).toBe(0);
    expect(decimalsFor(5000)).toBe(0);
    expect(decimalsFor(0.05)).toBe(2);
    expect(decimalsFor(0.005)).toBe(3);
    expect(decimalsFor(0.0002)).toBe(4);
  });

  it("refuses a nonsense step rather than producing one", () => {
    expect(decimalsFor(0)).toBe(0);
    expect(decimalsFor(Number.NaN)).toBe(0);
  });
});

// Round-2 review findings: two guarantees the first shape did not hold.
describe("guarantees the review found missing", () => {
  it("keeps very small extents distinguishable — no arbitrary cap", () => {
    // A 17-decimal cap printed both of these as 0.
    const res = resolutionFor(0, 1e-16, "DOUBLE");
    const first = snap(res.step, res);
    const second = snap(res.step * 2, res);
    expect(formatBound(first, res)).not.toBe(formatBound(second, res));
    expect(Number(formatBound(first, res))).toBe(first);
  });

  it("shows a typed bound finer than the slider as the number it is", () => {
    const res = resolutionFor(0, 1, "DOUBLE"); // step 0.005, 3 decimals
    // A slider value renders at the derived resolution…
    expect(exactText(0.305, res)).toBe("0.305");
    // …but a finer typed bound must not be rounded into a different number.
    expect(exactText(0.00123, res)).toBe("0.00123");
    expect(Number(exactText(0.00123, res))).toBe(0.00123);
  });

  it("renders an off-lattice extent endpoint exactly", () => {
    const res = resolutionFor(0.37, 19.99, "DOUBLE");
    expect(Number(exactText(19.99, res))).toBe(19.99);
  });
});

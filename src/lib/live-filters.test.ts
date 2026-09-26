import { describe, it, expect } from "vitest";
import {
  LIVE_FILTER_SLOTS,
  liveFilters,
  liveDim,
  dimFeatureValue,
  dimValues,
  dimRanges,
  numToValue,
  numToRange,
  NULL_NUM,
} from "@/lib/live-filters";
import { NULL_TIME_MS, timeToMs } from "@/lib/time";
import { POINTS_VIZ, defaultViz, type LayerFilter } from "@/lib/viz";

const range = (field: string, min: number | null, max: number | null) =>
  ({ field, kind: "range", min, max }) as const;
const timerange = (field: string, min: string | null, max: string | null) =>
  ({ field, kind: "timerange", min, max }) as const;
const values = (field: string, vals: string[]) =>
  ({ field, kind: "values", values: vals }) as const;

/** The GPU's in-range test, as deck's filter shader applies it. */
const inRange = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;

describe("liveFilters — the one delegation rule", () => {
  it("delegates range and time filters, never value filters", () => {
    const filters: LayerFilter[] = [
      values("city", ["Mainz"]),
      range("riders", 10, null),
      timerange("seen", null, "2021-06-01"),
    ];
    const live = liveFilters(POINTS_VIZ, filters);
    expect(live.map((f) => f.field)).toEqual(["riders", "seen"]);
  });

  it("delegates nothing on an aggregated layer", () => {
    const filters: LayerFilter[] = [range("riders", 10, 20)];
    expect(liveFilters(defaultViz("hexbin"), filters)).toEqual([]);
    expect(liveFilters(defaultViz("grid"), filters)).toEqual([]);
    expect(liveFilters(defaultViz("heatmap"), filters)).toHaveLength(1);
  });

  it("caps at the slot count, in filter order", () => {
    const filters: LayerFilter[] = [
      range("a", 1, null),
      range("b", 1, null),
      range("c", 1, null),
      range("d", 1, null),
      range("e", 1, null),
    ];
    const live = liveFilters(POINTS_VIZ, filters);
    expect(live).toHaveLength(LIVE_FILTER_SLOTS);
    expect(live.map((f) => f.field)).toEqual(["a", "b", "c", "d"]);
  });

  it("guarantees the docked timeline field a slot past the cutoff", () => {
    const filters: LayerFilter[] = [
      range("a", 1, null),
      range("b", 1, null),
      range("c", 1, null),
      range("d", 1, null),
      timerange("seen", null, null),
    ];
    const live = liveFilters(POINTS_VIZ, filters, "seen");
    expect(live).toHaveLength(LIVE_FILTER_SLOTS);
    expect(live.map((f) => f.field)).toContain("seen");
    expect(live.map((f) => f.field)).not.toContain("d");
  });
});

describe("numeric domain — row-for-row SQL parity", () => {
  it("a fully open filter keeps NULL rows; any real bound excludes them", () => {
    // SQL: no bounds compile to TRUE (NULLs pass); a bound's comparison
    // fails on NULL. The GPU domain mirrors both directions.
    expect(inRange(numToValue(null), numToRange(null, null))).toBe(true);
    expect(inRange(numToValue(null), numToRange(0, null))).toBe(false);
    expect(inRange(numToValue(null), numToRange(null, 0))).toBe(false);
    expect(inRange(numToValue("not a number"), numToRange(null, null))).toBe(
      true,
    );
  });

  it("bounds are inclusive, exactly like the compiled SQL", () => {
    expect(inRange(numToValue(10), numToRange(10, 20))).toBe(true);
    expect(inRange(numToValue(20), numToRange(10, 20))).toBe(true);
    expect(inRange(numToValue(9.999), numToRange(10, 20))).toBe(false);
    expect(inRange(numToValue(-5), numToRange(null, -5))).toBe(true);
  });

  it("clamps values and bounds monotonically, so ordering survives", () => {
    // Magnitudes beyond float32 clamp on BOTH sides of the comparison —
    // the ordering the filter reads is preserved.
    expect(inRange(numToValue(2e300), numToRange(1e250, null))).toBe(true);
    expect(inRange(numToValue(-2e300), numToRange(1e250, null))).toBe(false);
    expect(numToValue(null)).toBe(NULL_NUM);
  });

  it("accepts numeric strings — serialized rows keep filtering", () => {
    expect(numToValue("12.5")).toBe(12.5);
    expect(inRange(numToValue("12.5"), numToRange(10, 20))).toBe(true);
  });
});

describe("resolved dimensions", () => {
  it("resolves a time filter through the time conventions", () => {
    const dim = liveDim(timerange("seen", "2021-03-01", null));
    expect(dim.kind).toBe("timerange");
    expect(dim.range[0]).toBe(timeToMs("2021-03-01"));
    expect(
      inRange(dimFeatureValue(dim, "2021-03-02 08:00:00"), dim.range),
    ).toBe(true);
    expect(inRange(dimFeatureValue(dim, null), dim.range)).toBe(false);
    expect(dimFeatureValue(dim, null)).toBe(NULL_TIME_MS);
  });

  it("pads values and ranges to the fixed slot count, and padding passes", () => {
    const dims = [liveDim(range("riders", 10, 20))];
    const vals = dimValues(dims, { riders: 15 });
    const ranges = dimRanges(dims.map((d) => d.range));
    expect(vals).toHaveLength(LIVE_FILTER_SLOTS);
    expect(ranges).toHaveLength(LIVE_FILTER_SLOTS);
    for (let i = 0; i < LIVE_FILTER_SLOTS; i++) {
      expect(inRange(vals[i], ranges[i] as [number, number])).toBe(true);
    }
    // The real dim still filters.
    expect(inRange(dimValues(dims, { riders: 25 })[0], ranges[0])).toBe(false);
  });
});

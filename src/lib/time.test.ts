import { describe, it, expect } from "vitest";
import {
  timeToMs,
  windowToRange,
  msToBound,
  timeGranularity,
  formatTimeMs,
  NULL_TIME_MS,
  OPEN_START_MS,
  OPEN_END_MS,
} from "./time";

/**
 * Both serialized shapes that reach the client must parse identically:
 * DuckDB's JSON path ("2021-03-01 08:30:00") and GDAL's tile path
 * ("2021-03-01T08:30:00"). Naive values are UTC by convention.
 */

describe("timeToMs", () => {
  it("parses both property formats to the same instant", () => {
    const duckdb = timeToMs("2021-03-01 08:30:00");
    const gdal = timeToMs("2021-03-01T08:30:00");
    expect(duckdb).toBe(gdal);
    expect(duckdb).toBe(Date.UTC(2021, 2, 1, 8, 30, 0));
  });

  it("parses date-only, fractional seconds, and explicit offsets", () => {
    expect(timeToMs("2021-03-01")).toBe(Date.UTC(2021, 2, 1));
    expect(timeToMs("2021/03/01 08:30:00")).toBe(Date.UTC(2021, 2, 1, 8, 30));
    expect(timeToMs("2021-03-01T08:30:00.250")).toBe(
      Date.UTC(2021, 2, 1, 8, 30, 0, 250),
    );
    expect(timeToMs("2021-03-01T08:30:00Z")).toBe(
      Date.UTC(2021, 2, 1, 8, 30, 0),
    );
    expect(timeToMs("2021-03-01T08:30:00+02:00")).toBe(
      Date.UTC(2021, 2, 1, 6, 30, 0),
    );
  });

  it("parses DuckDB's TIMESTAMPTZ wire shape — the bare hour offset", () => {
    // The render route serializes tz-aware columns as "…08:30:00+00"; before
    // this fix the parse failed the pattern, mapped every row to the null
    // sentinel, and any committed time bound blanked the whole layer.
    expect(timeToMs("2021-03-01 08:30:00+00")).toBe(
      Date.UTC(2021, 2, 1, 8, 30, 0),
    );
    expect(timeToMs("2021-03-01T08:30:00+02")).toBe(
      Date.UTC(2021, 2, 1, 6, 30, 0),
    );
    expect(timeToMs("2021-03-01 08:30:00-05")).toBe(
      Date.UTC(2021, 2, 1, 13, 30, 0),
    );
    expect(timeToMs("2021-03-01T08:30:00+0200")).toBe(
      Date.UTC(2021, 2, 1, 6, 30, 0),
    );
    expect(timeToMs("2021-03-01 08:30:00.250+00")).toBe(
      Date.UTC(2021, 2, 1, 8, 30, 0, 250),
    );
    // A Z-suffixed source value and its +00 wire form are the same instant.
    expect(timeToMs("2021-03-01T08:30:00Z")).toBe(
      timeToMs("2021-03-01 08:30:00+00"),
    );
  });

  it("maps missing and unparseable values to the null sentinel", () => {
    expect(timeToMs(null)).toBe(NULL_TIME_MS);
    expect(timeToMs(undefined)).toBe(NULL_TIME_MS);
    expect(timeToMs(42)).toBe(NULL_TIME_MS);
    expect(timeToMs("not a date")).toBe(NULL_TIME_MS);
    expect(timeToMs("03/01/2021")).toBe(NULL_TIME_MS); // ambiguous US order
  });
});

describe("windowToRange", () => {
  it("mirrors SQL: real bounds exclude nulls, a fully open window keeps them", () => {
    const t = Date.UTC(2021, 2, 1);
    expect(windowToRange([t, t + 1000])).toEqual([t, t + 1000]);
    // One real bound: the sentinel stays outside — NULL fails the comparison.
    expect(windowToRange([null, t])).toEqual([OPEN_START_MS, t]);
    expect(windowToRange([t, null])).toEqual([t, OPEN_END_MS]);
    expect(OPEN_START_MS).toBeGreaterThan(NULL_TIME_MS);
    // Both open compiles to TRUE server-side — nothing excluded, nulls in.
    expect(windowToRange([null, null])).toEqual([NULL_TIME_MS, OPEN_END_MS]);
  });
});

describe("human time labels", () => {
  it("round-trips a bound through ms and back", () => {
    expect(msToBound(timeToMs("2021-03-01T08:30:00"))).toBe(
      "2021-03-01T08:30:00",
    );
  });

  it("picks granularity from the span and formats readably", () => {
    const day = 86_400_000;
    expect(timeGranularity(3_600_000)).toBe("time");
    expect(timeGranularity(30 * day)).toBe("datetime");
    expect(timeGranularity(400 * day)).toBe("date");

    const t = Date.UTC(2021, 2, 1, 8, 30, 15);
    expect(formatTimeMs(t, "date")).toBe("Mar 1, 2021");
    expect(formatTimeMs(t, "datetime")).toBe("Mar 1, 2021 08:30");
    expect(formatTimeMs(t, "time")).toBe("08:30:15");
  });
});

import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  GLOBAL_EQUAL_AREA,
  parseExtent,
  resolveMeasurementCrs,
  utmZone,
  type Extent,
} from "./measurement";

/**
 * The strategy, exhaustively.
 *
 * The split by kind is the whole rule, so every case is asked in both
 * directions: a distance takes a local projection or refuses, and an area may
 * fall back. A suite that only asked one kind would pass an implementation
 * that measured a buffer radius on an equal-area projection — the defect the
 * doctrine records committing inside itself.
 */

const berlin: Extent = { minLon: 13.3, minLat: 52.4, maxLon: 13.5, maxLat: 52.6 };
const madrid: Extent = { minLon: -3.8, minLat: 40.3, maxLon: -3.6, maxLat: 40.5 };

describe("the zone comes from the data's own extent", () => {
  it("resolves different zones for data in different places", () => {
    const a = resolveMeasurementCrs(berlin, "distance");
    const b = resolveMeasurementCrs(madrid, "distance");
    expect(a.crs).toBe("EPSG:32633");
    expect(b.crs).toBe("EPSG:32630");
    // The point of the criterion: not one CRS for everything.
    expect(a.crs).not.toBe(b.crs);
    expect(a.local).toBe(true);
  });

  it("puts southern data in a southern zone", () => {
    const sydney: Extent = { minLon: 151.1, minLat: -33.9, maxLon: 151.3, maxLat: -33.7 };
    expect(resolveMeasurementCrs(sydney, "distance").crs).toBe("EPSG:32756");
  });

  it("numbers zones from the antimeridian, six degrees at a time", () => {
    expect(utmZone(-180)).toBe(1);
    expect(utmZone(-174.1)).toBe(1);
    expect(utmZone(-174)).toBe(2);
    expect(utmZone(0)).toBe(31);
    expect(utmZone(13.4)).toBe(33);
    expect(utmZone(179.9)).toBe(60);
  });
});

describe("where no local projection covers it", () => {
  const cases: [string, Extent][] = [
    [
      "spanning more than one zone",
      { minLon: 5, minLat: 45, maxLon: 25, maxLat: 55 },
    ],
    [
      "spanning both hemispheres",
      { minLon: 13, minLat: -5, maxLon: 14, maxLat: 5 },
    ],
    [
      "beyond the projection's own latitude band",
      { minLon: 13, minLat: 80, maxLon: 14, maxLat: 88 },
    ],
  ];

  for (const [label, extent] of cases) {
    it(`refuses a distance over data ${label}`, () => {
      try {
        resolveMeasurementCrs(extent, "distance");
        throw new Error("should have refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe("measurement_crs_unavailable");
        // The refusal carries what a user needs in order to act: the extent it
        // saw, and why nothing covered it.
        expect((error as ApiError).message).toContain(String(extent.minLon.toFixed(4)));
        expect((error as ApiError).message).toMatch(/split it by region/i);
      }
    });

    it(`answers an area over the same data instead of refusing`, () => {
      const resolved = resolveMeasurementCrs(extent, "area");
      expect(resolved.crs).toBe(GLOBAL_EQUAL_AREA);
      expect(resolved.local).toBe(false);
    });
  }

  it("measures every area in the global equal-area projection", () => {
    // The spike's answer: an equal-area projection is accurate to ~0.001 % at
    // every latitude while a local UTM zone drifts to 0.08 %, because UTM
    // preserves shape rather than area. One answer everywhere also keeps a
    // dataset's area meaning the same as its extent grows.
    for (const extent of [berlin, madrid]) {
      const resolved = resolveMeasurementCrs(extent, "area");
      expect(resolved.crs).toBe(GLOBAL_EQUAL_AREA);
      expect(resolved.local).toBe(false);
    }
    // And a distance over the same data does *not* take it.
    expect(resolveMeasurementCrs(berlin, "distance").crs).toBe("EPSG:32633");
  });
});

describe("reading the engine's own extent", () => {
  it("parses a box, longitude first", () => {
    expect(parseExtent("BOX(13.1 52.1, 13.9 52.9)")).toEqual({
      minLon: 13.1,
      minLat: 52.1,
      maxLon: 13.9,
      maxLat: 52.9,
    });
  });

  it("parses negatives and exponents", () => {
    expect(parseExtent("BOX(-3.8 -33.9, 1e-2 40.5)")).toEqual({
      minLon: -3.8,
      minLat: -33.9,
      maxLon: 0.01,
      maxLat: 40.5,
    });
  });

  it("answers null for anything it cannot read, rather than a wrong box", () => {
    // A silently wrong extent picks a silently wrong projection, which is the
    // whole failure class this spec exists to prevent.
    expect(parseExtent("")).toBeNull();
    expect(parseExtent("POINT (13 52)")).toBeNull();
    expect(parseExtent("BOX(13.1 52.1)")).toBeNull();
  });
});

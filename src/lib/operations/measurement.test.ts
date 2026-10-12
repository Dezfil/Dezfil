import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  GLOBAL_EQUAL_AREA,
  MAX_DISTANCE_ERROR,
  parseExtent,
  resolveMeasurementCrs,
  transverseMercatorAt,
  worstDistanceError,
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
/** Kigali straddles 30° E and London 0°: a fixed six-degree zone's edges. */
const kigali: Extent = { minLon: 29.98, minLat: -2.06, maxLon: 30.2, maxLat: -1.88 };
const london: Extent = { minLon: -0.51, minLat: 51.28, maxLon: 0.33, maxLat: 51.69 };

/**
 * The scale factor of a transverse Mercator on a **sphere**, exact:
 * 1 / sqrt(1 - B²) with B = cos(latitude) · sin(offset from the centre). A
 * second formula for the bound, independent of the ellipsoidal series the
 * strategy uses; the two agree to a few parts in a thousand of the error near
 * the bound, which is all the cases below lean on.
 */
function sphericalError(latitude: number, offset: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const b = Math.cos(rad(latitude)) * Math.sin(rad(offset));
  return 1 / Math.sqrt(1 - b * b) - 1;
}

function refusal(extent: Extent): { code?: string; message: string } {
  try {
    resolveMeasurementCrs(extent, "distance");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return { code: (error as ApiError).code, message: (error as ApiError).message };
  }
  throw new Error("should have refused");
}

describe("the projection centres on the data's own extent", () => {
  it("resolves different projections for data in different places", () => {
    const a = resolveMeasurementCrs(berlin, "distance");
    const b = resolveMeasurementCrs(madrid, "distance");
    expect(a.crs).toBe(transverseMercatorAt(13.4));
    expect(b.crs).toBe(transverseMercatorAt(-3.7));
    // The point of the criterion: not one CRS for everything.
    expect(a.crs).not.toBe(b.crs);
    expect(a.local).toBe(true);
  });

  it("names a transverse Mercator on the WGS 84 datum, in metres, true along its middle", () => {
    expect(transverseMercatorAt(30.09)).toBe(
      "+proj=tmerc +lat_0=0 +lon_0=30.09 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs",
    );
  });

  it("measures a city on a fixed zone's edge: Kigali on 30° E, London on 0°", () => {
    // Both were refused while every distance took one six-degree zone.
    const k = resolveMeasurementCrs(kigali, "distance");
    expect(k).toEqual({ crs: transverseMercatorAt(30.09), local: true });
    const l = resolveMeasurementCrs(london, "distance");
    expect(l).toEqual({ crs: transverseMercatorAt(-0.09), local: true });
  });

  it("measures across the equator and near a pole, where nothing in the width forbids it", () => {
    const equator: Extent = { minLon: 13, minLat: -5, maxLon: 14, maxLat: 5 };
    const svalbard: Extent = { minLon: 13, minLat: 80, maxLon: 14, maxLat: 88 };
    expect(resolveMeasurementCrs(equator, "distance").local).toBe(true);
    expect(resolveMeasurementCrs(svalbard, "distance").local).toBe(true);
  });

  it("measures a whole country or region whose width keeps within the bound", () => {
    const rwanda: Extent = { minLon: 28.86, minLat: -2.84, maxLon: 30.9, maxLat: -1.05 };
    const philippines: Extent = { minLon: 116.9, minLat: 4.6, maxLon: 126.6, maxLat: 21.1 };
    const easternAustralia: Extent = { minLon: 138, minLat: -37.6, maxLon: 153.6, maxLat: -10 };
    for (const extent of [rwanda, philippines, easternAustralia]) {
      expect(resolveMeasurementCrs(extent, "distance").local).toBe(true);
    }
  });
});

describe("the bound: the worst distance error anywhere in the extent", () => {
  it("is one percent", () => {
    expect(MAX_DISTANCE_ERROR).toBe(0.01);
  });

  it("is the scale at the extent's widest point: its edge nearest the equator", () => {
    // The same width at three latitudes: the error falls as a degree of
    // longitude shortens, and an extent reaching the equator is judged there.
    const at = (minLat: number, maxLat: number): Extent => ({ minLon: 0, minLat, maxLon: 10, maxLat });
    expect(worstDistanceError(at(-3, 4))).toBeCloseTo(sphericalError(0, 5), 4);
    expect(worstDistanceError(at(40, 60))).toBeCloseTo(sphericalError(40, 5), 4);
    expect(worstDistanceError(at(-60, -40))).toBeCloseTo(sphericalError(40, 5), 4);
    expect(worstDistanceError(at(40, 60))).toBeLessThan(worstDistanceError(at(-3, 4)));
  });

  it("admits an extent just under it and refuses one just over it", () => {
    // At the equator the bound falls at about 8.04° either side of the
    // middle. 16.0° wide is 0.99 %; 16.2° is 1.01 %.
    const under: Extent = { minLon: 20, minLat: -1, maxLon: 36, maxLat: 1 };
    const over: Extent = { minLon: 20, minLat: -1, maxLon: 36.2, maxLat: 1 };
    expect(sphericalError(0, 8.0)).toBeLessThan(0.01);
    expect(sphericalError(0, 8.1)).toBeGreaterThan(0.01);
    expect(resolveMeasurementCrs(under, "distance").crs).toBe(transverseMercatorAt(28));
    const refused = refusal(over);
    expect(refused.code).toBe("measurement_crs_unavailable");
    // It names the width and the error it would have carried, and says what
    // to do: split into parts no wider than what measures honestly here.
    expect(refused.message).toContain("16.2° of longitude");
    expect(refused.message).toContain("off by 1.01 %");
    expect(refused.message).toMatch(/split it by region into parts spanning at most 16\.0° of longitude/i);
    expect(refused.message).toContain(String(over.minLon.toFixed(4)));
  });

  it("allows a wider extent further from the equator, as the scale says", () => {
    // 26° wide is over the bound at the equator and under it at 52° N, where
    // the bound falls at about 13.2° either side.
    const north: Extent = { minLon: 0, minLat: 52, maxLon: 26, maxLat: 56 };
    const equatorial: Extent = { minLon: 0, minLat: -2, maxLon: 26, maxLat: 2 };
    expect(resolveMeasurementCrs(north, "distance").local).toBe(true);
    expect(refusal(equatorial).code).toBe("measurement_crs_unavailable");
  });
});

describe("where no one projection measures it honestly", () => {
  const cases: [string, Extent, RegExp][] = [
    ["spanning a continent", { minLon: 5, minLat: 10, maxLon: 45, maxLat: 30 }, /40\.0° of longitude/],
    ["spanning the world", { minLon: -180, minLat: -60, maxLon: 180, maxLat: 80 }, /360\.0° of longitude/],
    [
      "crossing the antimeridian as stored, from -179.9° to 179.9°",
      { minLon: -179.9, minLat: -19, maxLon: 179.9, maxLat: -16 },
      /antimeridian/,
    ],
    [
      "crossing the antimeridian in longitudes past 180°",
      { minLon: 175, minLat: -19, maxLon: 182, maxLat: -16 },
      /crosses the antimeridian/,
    ],
  ];

  for (const [label, extent, said] of cases) {
    it(`refuses a distance over data ${label}`, () => {
      const refused = refusal(extent);
      expect(refused.code).toBe("measurement_crs_unavailable");
      // The refusal carries what a user needs in order to act: the extent it
      // saw, why no projection measures it, and what to do.
      expect(refused.message).toContain(String(extent.minLon.toFixed(4)));
      expect(refused.message).toMatch(said);
      expect(refused.message).toMatch(/split it/i);
    });

    it(`answers an area over the same data instead of refusing`, () => {
      const resolved = resolveMeasurementCrs(extent, "area");
      expect(resolved.crs).toBe(GLOBAL_EQUAL_AREA);
      expect(resolved.local).toBe(false);
    });
  }

  it("measures every area in the global equal-area projection", () => {
    // The spike's answer: an equal-area projection is accurate to ~0.001 % at
    // every latitude while a conformal local projection drifts to 0.08 %,
    // because it preserves shape rather than area. One answer everywhere also
    // keeps a dataset's area meaning the same as its extent grows.
    for (const extent of [berlin, madrid]) {
      const resolved = resolveMeasurementCrs(extent, "area");
      expect(resolved.crs).toBe(GLOBAL_EQUAL_AREA);
      expect(resolved.local).toBe(false);
    }
    // And a distance over the same data does *not* take it.
    expect(resolveMeasurementCrs(berlin, "distance").crs).toBe(transverseMercatorAt(13.4));
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

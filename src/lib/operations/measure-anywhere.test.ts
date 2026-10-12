import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getJob } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { startRun } from "./run";
import { laneSettled, resetLane } from "./lane";
import {
  intoMeasurement,
  resolveMeasurementCrs,
  transverseMercatorAt,
  worstDistanceError,
  type Extent,
} from "./measurement";

/**
 * Measured anywhere a city or a country lies, end to end through the engine.
 *
 * **Two cities on the edges of fixed six-degree zones**: Kigali straddles
 * 30° E and London 0°. A nearest join across each was refused while every
 * distance took one such zone, and is answered now in a projection centred on
 * the data.
 *
 * **The answer is held against the ellipsoid, not against the projection.**
 * Each expected distance is a geodesic on WGS 84 computed here by Vincenty's
 * inverse formula, independent of the engine and of any projection, so a
 * measurement in the wrong place, the wrong units or the wrong scale fails.
 *
 * **The bound is held against the engine's own stretch.** The error the
 * strategy computes for an extent is compared with the error the engine
 * actually makes at that extent's edge in the projection it was given.
 */

let dir: string;

type Place = { name: string; lon: number; lat: number };

/** Clinics and hospitals either side of 30° E in Kigali. */
const KIGALI_CLINICS: Place[] = [
  { name: "k_west", lon: 29.99, lat: -1.95 },
  { name: "k_centre", lon: 30.13, lat: -1.97 },
  { name: "k_east", lon: 30.19, lat: -1.9 },
];
const KIGALI_HOSPITALS: Place[] = [
  { name: "h_kacyiru", lon: 30.06, lat: -1.95 },
  { name: "h_kanombe", lon: 30.18, lat: -1.93 },
];

/** Stops either side of the prime meridian in London. */
const LONDON_STOPS: Place[] = [
  { name: "l_charing_cross", lon: -0.1276, lat: 51.5072 },
  { name: "l_stratford", lon: -0.0042, lat: 51.5416 },
  { name: "l_barking", lon: 0.0809, lat: 51.5396 },
  { name: "l_richmond", lon: -0.3016, lat: 51.4613 },
];
const LONDON_PARKS: Place[] = [
  { name: "p_greenwich", lon: -0.0014, lat: 51.4779 },
  { name: "p_wanstead", lon: 0.035, lat: 51.565 },
  { name: "p_hyde", lon: -0.1657, lat: 51.5073 },
];

const rad = (d: number) => (d * Math.PI) / 180;

/** The geodesic between two points on the WGS 84 ellipsoid, in metres:
 * Vincenty's inverse formula (Survey Review, 1975), iterated to 1e-12. */
function geodesic(a: Place, b: Place): number {
  const major = 6378137;
  const f = 1 / 298.257223563;
  const minor = major * (1 - f);
  const l = rad(b.lon - a.lon);
  const u1 = Math.atan((1 - f) * Math.tan(rad(a.lat)));
  const u2 = Math.atan((1 - f) * Math.tan(rad(b.lat)));
  const [sinU1, cosU1, sinU2, cosU2] = [Math.sin(u1), Math.cos(u1), Math.sin(u2), Math.cos(u2)];
  let lambda = l;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cos2Alpha = 0, cos2SigmaM = 0;
  for (let i = 0; i < 200; i += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const c = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const previous = lambda;
    lambda = l + (1 - c) * f * sinAlpha *
      (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }
  const uu = (cos2Alpha * (major ** 2 - minor ** 2)) / minor ** 2;
  const big = 1 + (uu / 16384) * (4096 + uu * (-768 + uu * (320 - 175 * uu)));
  const small = (uu / 1024) * (256 + uu * (-128 + uu * (74 - 47 * uu)));
  const deltaSigma = small * sinSigma * (cos2SigmaM + (small / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
    (small / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return minor * big * (sigma - deltaSigma);
}

/**
 * How close a measured distance must come to the geodesic. A transverse
 * Mercator centred on a city's extent is longer than the ground by a few
 * parts in a million at the city's edge, so one part in ten thousand leaves
 * room for that and nothing else: a degree-space distance, a sphere's, or a
 * projection centred a zone away all miss it.
 */
const TOLERANCE = 1e-4;

async function seed(name: string, places: Place[]) {
  const file = path.join(dir, `${name}.csv`);
  await writeFile(file, `name,lon,lat\n${places.map((p) => `${p.name},${p.lon},${p.lat}`).join("\n")}\n`);
  await ingestFile(testAccountScope(), file, `${name}.csv`);
}

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-anywhere-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function nearestJoin(left: string, right: string, name: string) {
  const job = await startRun(testAccountScope(), {
    operation: "nearest_join",
    parameters: { left, right, carry: [], name },
  });
  await laneSettled();
  const settled = getJob(job.id)!;
  expect(settled.state, settled.errorMessage ?? "").toBe("succeeded");
  const rows = (await executeQuery(testAccountScope(), `SELECT name, nearest_distance_m FROM ${name}`)).preview;
  return new Map(rows.map((r) => [String(r.name), Number(r.nearest_distance_m)]));
}

function expectGeodesic(measured: Map<string, number>, from: Place[], to: Place[]) {
  expect(measured.size).toBe(from.length);
  for (const place of from) {
    const expected = Math.min(...to.map((other) => geodesic(place, other)));
    const actual = measured.get(place.name)!;
    expect(Math.abs(actual / expected - 1), `${place.name}: ${actual} m against ${expected} m`).toBeLessThan(TOLERANCE);
  }
}

describe("a nearest join on a fixed zone's edge", () => {
  it("answers across Kigali, on 30° E, in geodesic metres", async () => {
    await seed("clinics", KIGALI_CLINICS);
    await seed("hospitals", KIGALI_HOSPITALS);
    const measured = await nearestJoin("clinics", "hospitals", "clinics_nearest");
    expectGeodesic(measured, KIGALI_CLINICS, KIGALI_HOSPITALS);
    // Centred on both inputs together, 29.99° to 30.19°: every input counts.
    const recorded = getTableByName("clinics_nearest")!.sourceParams?.measurement as {
      crs?: Record<string, string>;
      fallback?: boolean;
    };
    expect(recorded?.crs?.distance).toBe(transverseMercatorAt(30.09));
    expect(recorded?.fallback).toBe(false);
  }, 60_000);

  it("answers across London, on 0°, in geodesic metres", async () => {
    await seed("stops", LONDON_STOPS);
    await seed("parks", LONDON_PARKS);
    const measured = await nearestJoin("stops", "parks", "stops_nearest");
    expectGeodesic(measured, LONDON_STOPS, LONDON_PARKS);
  }, 60_000);
});

describe("the bound against the engine's own stretch", () => {
  /** The relative error the engine makes over one hundredth of a degree
   * east–west at a point, in the projection the strategy resolved. */
  async function stretchAt(crs: string, lon: number, lat: number): Promise<number> {
    const a = { name: "a", lon: lon - 0.01, lat };
    const b = { name: "b", lon, lat };
    const result = await executeQuery(testAccountScope(),
      `SELECT ST_Distance(${intoMeasurement(`ST_Point(${a.lon}, ${a.lat})`, crs)},
                          ${intoMeasurement(`ST_Point(${b.lon}, ${b.lat})`, crs)}) AS d`,
    );
    return Number(result.preview[0].d) / geodesic(a, b) - 1;
  }

  it("states the error the engine makes at the edge of an extent just under it", async () => {
    // 16° wide at the equator: about 0.99 % at the east and west edges.
    const under: Extent = { minLon: 20, minLat: -1, maxLon: 36, maxLat: 1 };
    const { crs } = resolveMeasurementCrs(under, "distance");
    const engine = await stretchAt(crs, under.maxLon, 0);
    expect(Math.abs(engine - worstDistanceError(under))).toBeLessThan(2e-4);
    expect(engine).toBeLessThan(0.01);
    // And exact along the middle, where the projection is centred.
    expect(Math.abs(await stretchAt(crs, 28.005, 0))).toBeLessThan(1e-6);
  }, 60_000);

  it("would carry more than one percent at the edge of an extent just over it", async () => {
    // The refused extent, measured anyway in the projection it would have
    // taken: the refusal is about a real error, not an arbitrary width.
    const over: Extent = { minLon: 20, minLat: -1, maxLon: 36.2, maxLat: 1 };
    expect(() => resolveMeasurementCrs(over, "distance")).toThrow(/too wide/);
    const engine = await stretchAt(transverseMercatorAt(28.1), over.maxLon, 0);
    expect(Math.abs(engine - worstDistanceError(over))).toBeLessThan(2e-4);
    expect(engine).toBeGreaterThan(0.01);
  }, 60_000);
});

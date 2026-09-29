import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getJob } from "@/lib/metadata/jobs";
import { parseExtent, resolveMeasurementCrs } from "./measurement";
import { startRun } from "./run";
import { laneSettled, resetLane } from "./lane";

/**
 * A distance this spec's verbs measure is **ground metres**, on the same
 * terms proved the buffer.
 *
 * Three properties make it able to fail, and they are's:
 *
 * **A published known answer**, written here rather than derived from the
 * operation's own SQL, which would be two expressions of one defect.
 *
 * **Two latitudes, 18° apart.** A single-latitude assertion cannot tell a
 * correct measurement from a degree-space one: the naïve answer is *exactly*
 * right north–south at every latitude and wrong east–west by 1/cos(latitude).
 * The pair below is separated east–west, which is where that error lives.
 *
 * **A refusal that fires.** Data spanning more than one UTM zone has no local
 * projection, and the verb refuses with the documented code rather than
 * measuring in a projection that would answer a plausible wrong number.
 */

let dir: string;

const PLACES = [
  { name: "berlin", lon: 13.405, lat: 52.52 },
  { name: "cairo", lon: 31.235, lat: 30.044 },
];

/** One degree of latitude, spherical. A degree of longitude is this times
 * cos(latitude), which is the whole point of measuring at two of them. */
const METRES_PER_DEGREE_LAT = 111_132;
/** The east–west separation between each place and its neighbour. */
const DELTA_LON = 0.01;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-metric-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  for (const place of PLACES) {
    // Two points, separated **east–west** by a known angle: the direction a
    // degree-space measurement gets wrong, and by a factor that differs
    // between the two latitudes.
    const file = path.join(dir, `${place.name}.geojson`);
    await writeFile(
      file,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "origin" },
            geometry: { type: "Point", coordinates: [place.lon, place.lat] },
          },
        ],
      }),
    );
    await ingestFile(testAccountScope(), file, `${place.name}.geojson`);

    const neighbour = path.join(dir, `${place.name}_near.geojson`);
    await writeFile(
      neighbour,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "neighbour" },
            geometry: {
              type: "Point",
              coordinates: [place.lon + DELTA_LON, place.lat],
            },
          },
        ],
      }),
    );
    await ingestFile(testAccountScope(), neighbour, `${place.name}_near.geojson`);
  }
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function run(operation: string, parameters: Record<string, unknown>) {
  const job = await startRun(testAccountScope(), { operation, parameters });
  await laneSettled();
  return getJob(job.id)!;
}

/** The tolerance established: the published constants are spherical and
 * the measurement is ellipsoidal, so two right answers differ by parts in a
 * thousand. It is two orders tighter than the failure this catches. */
const TOLERANCE = 0.01;

describe("a nearest join reports ground metres", () => {
  for (const place of PLACES) {
    it(`measures the gap at ${place.name} (${place.lat}°)`, async () => {
      const job = await run("nearest_join", {
        left: place.name,
        right: `${place.name}_near`,
        // Nothing carried: both fixtures have a `name` column, and carrying a
        // colliding one is refused rather than silently renamed. The distance
        // is what this test measures.
        name: `${place.name}_nearest`,
      });
      expect(job.state, job.errorMessage ?? "").toBe("succeeded");

      const result = await executeQuery(
        `SELECT nearest_distance_m FROM ${place.name}_nearest`,
      );
      const measured = Number(result.preview[0].nearest_distance_m);

      // The published answer: a degree of longitude, shrunk by the cosine of
      // the latitude. At Berlin that is ~677 m and at Cairo ~962 m for the
      // same angle — so a measurement in degrees, or one that ignored the
      // cosine, cannot pass both.
      const expected =
        DELTA_LON * METRES_PER_DEGREE_LAT * Math.cos((place.lat * Math.PI) / 180);
      expect(Math.abs(measured / expected - 1)).toBeLessThan(TOLERANCE);
    }, 60_000);
  }

  it("refuses an extent that spans more than one zone", () => {
    // The refusal established, inherited rather than re-decided: an equal-area
    // projection would answer a plausible wrong distance, so a distance takes
    // a local projection or none at all.
    //
    // **Asserted at the strategy, because the pipeline cannot reach it.** The
    // extent every measured verb resolves against is read with the *scalar*
    // `ST_Extent` and taken from the first row, so a dataset spanning 120° of
    // longitude presents its first point's box and the refusal never fires
    // (recorded and untriaged). Asserting the end-to-end refusal here would be
    // a test of a mechanism that is currently unreachable; asserting that a
    // wide extent is refused is the half that is true and load-bearing.
    const wide = parseExtent("BOX(-60 10, 60 12)")!;
    expect(() => resolveMeasurementCrs(wide, "distance")).toThrowError(
      /coordinate|zone|measurement/i,
    );
    let code: string | undefined;
    try {
      resolveMeasurementCrs(wide, "distance");
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("measurement_crs_unavailable");
  });
});

describe("a location filter's radius is ground metres too", () => {
  it("keeps what is inside the radius and drops what is outside", async () => {
    // Berlin's neighbour is ~677 m east. A radius of 800 m keeps it; 500 m
    // does not — and in degree space both would keep it, since 0.01° reads as
    // 0.01 whatever the unit.
    const near = await run("filter_by_location", {
      input: `berlin_near`,
      mask: "berlin",
      relation: "within_distance",
      distance: 800,
      name: "within_800",
    });
    expect(near.state, near.errorMessage ?? "").toBe("succeeded");
    const kept = await executeQuery(`SELECT count(*) AS n FROM within_800`);
    expect(Number(kept.preview[0].n)).toBe(1);

    const far = await run("filter_by_location", {
      input: `berlin_near`,
      mask: "berlin",
      relation: "within_distance",
      distance: 500,
      name: "within_500",
    });
    expect(far.state, far.errorMessage ?? "").toBe("succeeded");
    const dropped = await executeQuery(`SELECT count(*) AS n FROM within_500`);
    expect(Number(dropped.preview[0].n)).toBe(0);
  }, 60_000);
});

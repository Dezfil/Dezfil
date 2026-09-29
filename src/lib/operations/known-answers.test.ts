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
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { materialize } from "./materialize";
import { startRun } from "./run";
import { startStepRun } from "./step-execution";
import { laneSettled, resetLane } from "./lane";
import { resolveMeasurementCrs } from "./measurement";
import { bufferSql } from "./metric-verbs";

/**
 * The numeric-truth acceptance layer.
 *
 * **Nothing else in this repository asserts a ground measurement produced by
 * the query engine.** Everything else is an axis-order check on coordinates —
 * proof that a point landed where it started, not that a length is a length.
 * This is the layer, and it is a deliverable of the spec rather than a note in
 * its plan.
 *
 * Four properties make it able to fail.
 *
 * **Published known answers**, written here by hand rather than derived from
 * the operation's own SQL, which would be two expressions of one defect.
 *
 * **Two latitudes, far apart.** A single-latitude assertion cannot tell a
 * correct measurement from a projection error that vanishes there — the naïve
 * degree buffer is *exactly* right in the north–south direction at every
 * latitude, and wrong east–west by 1/cos(latitude).
 *
 * **Area and distance kept apart**, because the strategy splits on precisely
 * that: a suite asserting only areas passes an equal-area projection measuring
 * a radius.
 *
 * **A seeded defect, exercised.** Transposing the coordinate pair must make
 * this fail. A layer that cannot be made to fail certifies the one thing it
 * cannot see.
 */

let dir: string;

/** Two places 18° apart in latitude, so a cosine error cannot hide. */
const PLACES = [
  { name: "berlin", lon: 13.405, lat: 52.52 },
  { name: "cairo", lon: 31.235, lat: 30.044 },
];

const METRES_PER_DEGREE_LAT = 111_132;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  for (const place of PLACES) {
    const file = path.join(dir, `${place.name}.csv`);
    await writeFile(file, `name,lon,lat\n${place.name},${place.lon},${place.lat}\n`);
    await ingestFile(testAccountScope(), file, `${place.name}.csv`);
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

async function runStep(stepId: string) {
  const job = await startStepRun(testAccountScope(), stepId);
  await laneSettled();
  return getJob(job.id)!;
}

/**
 * How close two numbers are, as a fraction.
 *
 * The published constants below are **spherical**: one degree of latitude is
 * 111,132 m, and a degree of longitude shrinks by cos(latitude). The
 * measurement happens in an **ellipsoidal** projection with its own scale
 * factor, so the two disagree by a few parts in a thousand *by construction*.
 * That residual is the difference between two right answers, not an error in
 * either — so the tolerance is 1 %, which is two orders tighter than the
 * failure this layer exists to catch (a degree buffer is wrong by 64 % at
 * Berlin's latitude).
 */
const TOLERANCE = 0.01;
const near = (actual: number, expected: number) =>
  Math.abs(actual / expected - 1);

/** The buffer's extent in degrees, which is where the ground truth shows. */
async function ringExtent(table: string) {
  const result = await executeQuery(
    `SELECT ST_XMin(ST_Extent(geometry)) AS x0, ST_XMax(ST_Extent(geometry)) AS x1,
            ST_YMin(ST_Extent(geometry)) AS y0, ST_YMax(ST_Extent(geometry)) AS y1
     FROM ${table}`,
  );
  const r = result.preview[0];
  return {
    width: Number(r.x1) - Number(r.x0),
    height: Number(r.y1) - Number(r.y0),
  };
}

describe("a distance is ground metres", () => {
  const RADIUS = 500;

  for (const place of PLACES) {
    it(`stands ${RADIUS} m from its input at ${place.name} (${place.lat}°)`, async () => {
      const job = await run("buffer", {
        input: place.name,
        distance: RADIUS,
        name: `${place.name}_ring`,
      });
      expect(job.state).toBe("succeeded");

      const { width, height } = await ringExtent(`${place.name}_ring`);

      // North–south: one degree of latitude is 111,132 m everywhere, so the
      // ring should be 2 × 500 m tall. The published constant, not a number
      // this code computed.
      const expectedHeight = (2 * RADIUS) / METRES_PER_DEGREE_LAT;
      expect(near(height, expectedHeight)).toBeLessThan(TOLERANCE);

      // East–west: a degree of longitude shrinks by cos(latitude), so the ring
      // is *wider in degrees* the further north it is — and equal on the
      // ground. This is the assertion the naïve degree buffer fails, because
      // it makes a shape that is right north–south and wrong east–west.
      const expectedWidth =
        (2 * RADIUS) /
        (METRES_PER_DEGREE_LAT * Math.cos((place.lat * Math.PI) / 180));
      expect(near(width, expectedWidth)).toBeLessThan(TOLERANCE);

      // And the two agree *on the ground*, which is what "not anisotropic"
      // means. A degree buffer is 1.6:1 at Berlin's latitude.
      const groundWidth =
        width * METRES_PER_DEGREE_LAT * Math.cos((place.lat * Math.PI) / 180);
      const groundHeight = height * METRES_PER_DEGREE_LAT;
      expect(near(groundWidth, groundHeight)).toBeLessThan(TOLERANCE);
    }, 120_000);
  }

  it("is centred on the point asked about, not on its transposition", async () => {
    // Berlin is 13.4E 52.5N. Transposed it is 52.5E 13.4N — in Saudi Arabia,
    // some 4,500 km away. A believable distance between two real places that
    // are not the two places asked about is the failure this catches.
    await run("buffer", { input: "berlin", distance: 500, name: "berlin_centre" });
    const result = await executeQuery(
      `SELECT ST_X(ST_Centroid(geometry)) AS x, ST_Y(ST_Centroid(geometry)) AS y
       FROM berlin_centre`,
    );
    expect(Number(result.preview[0].x)).toBeCloseTo(13.405, 2);
    expect(Number(result.preview[0].y)).toBeCloseTo(52.52, 2);
  }, 120_000);
});

describe("an area and a length are asserted separately", () => {
  it("measures a known square's area and perimeter length at two latitudes", async () => {
    for (const place of PLACES) {
      // A ring of exactly 1,000 m radius, then measured. Its area is πr² and
      // its perimeter 2πr, both published here — and the engine's polygon
      // approximation of a circle is about 0.64 % low, which is the tolerance
      // rather than a fudge.
      await run("buffer", {
        input: place.name,
        distance: 1000,
        name: `${place.name}_disc`,
      });
      const job = await run("measure_columns", {
        input: `${place.name}_disc`,
        measures: ["area", "length"],
        name: `${place.name}_measured`,
      });
      expect(job.state).toBe("succeeded");

      const result = await executeQuery(
        `SELECT area_m2, length_m FROM ${place.name}_measured`,
      );
      const area = Number(result.preview[0].area_m2);
      const length = Number(result.preview[0].length_m);

      // Published: πr² = 3,141,593 m² and 2πr = 6,283 m for r = 1,000 m. The
      // engine draws a circle as a polygon, about 0.64 % short of the true
      // one, which is why the window is one-sided and stated rather than
      // symmetric.
      expect(near(area, Math.PI * 1000 * 1000)).toBeLessThan(0.02);
      expect(near(length, 2 * Math.PI * 1000)).toBeLessThan(0.02);
      expect(area).toBeLessThan(Math.PI * 1000 * 1000 * 1.001);
      expect(length).toBeLessThan(2 * Math.PI * 1000 * 1.001);
    }
  }, 240_000);

  it("keeps x and y as stored coordinates, not measurements", async () => {
    const job = await run("measure_columns", {
      input: "berlin",
      measures: ["x", "y"],
      name: "berlin_xy",
    });
    expect(job.state).toBe("succeeded");
    const result = await executeQuery("SELECT x, y FROM berlin_xy");
    expect(Number(result.preview[0].x)).toBeCloseTo(13.405, 3);
    expect(Number(result.preview[0].y)).toBeCloseTo(52.52, 3);
    // Named as coordinates: no metre column appears for a measure that is not
    // one.
    expect(result.columns.map((c) => c.name)).not.toContain("area_m2");
    expect(result.columns.map((c) => c.name)).not.toContain("length_m");
  }, 120_000);
});

describe("the seeded defect, exercised", () => {
  it("fails when the coordinate pair is transposed", async () => {
    // The layer's own red proof. The same generator, the same known answer —
    // and an input whose coordinates are the wrong way round, which is the
    // defect M3 says returns a plausible number between two real places that
    // are not the ones asked about.
    const table = getTableByName("berlin")!;
    const crs = resolveMeasurementCrs(
      { minLon: 13.405, minLat: 52.52, maxLon: 13.405, maxLat: 52.52 },
      "distance",
    );

    const honest = bufferSql(table, 500, crs);
    const transposed = honest.replace(
      /t\."geometry"/g,
      `ST_Point(ST_Y(t."geometry"), ST_X(t."geometry"))`,
    );
    // The seeding actually changed the statement — a replacement that matched
    // nothing would make this whole case vacuous.
    expect(transposed).not.toBe(honest);

    const expectedHeight = (2 * 500) / METRES_PER_DEGREE_LAT;
    const assertHonest = (h: number) =>
      expect(near(h, expectedHeight)).toBeLessThan(TOLERANCE);
    const measure = async (sql: string) => {
      const r = await executeQuery(
        `SELECT ST_YMax(ST_Extent(geometry)) - ST_YMin(ST_Extent(geometry)) AS h
         FROM (${sql})`,
      );
      return Number(r.preview[0].h);
    };

    // The honest statement passes the layer's own assertion…
    assertHonest(await measure(honest));
    // …and the transposed one does not. If this ever stopped failing, every
    // assertion above would be certifying something it cannot see.
    await expect(
      measure(transposed).then(assertHonest),
    ).rejects.toThrow();
  }, 120_000);
});

describe("the same verbs run as recipe steps", () => {
  it("measures identically whether authored as a step or run one-off", async () => {
    // Criterion 19 is conjunctive — both verbs, both as steps and as one-off
    // runs — and an earlier version of this record marked it confirmed on the
    // one-off half alone.
    const recipeId = createRecipe(testAccountScope(), "metric").id;
    const buffer = addStep(recipeId, {
      operation: "buffer",
      parameters: { input: "berlin", distance: 500, name: "step_ring" },
    });
    const bufferJob = await runStep(buffer.id);
    expect(bufferJob.state).toBe("succeeded");

    const measured = addStep(recipeId, {
      operation: "measure_columns",
      parameters: {
        input: "step_ring",
        measures: ["area", "length"],
        name: "step_measured",
      },
    });
    const measuredJob = await runStep(measured.id);
    expect(measuredJob.state).toBe("succeeded");

    // The same known answers as the one-off path: a step is not a different
    // measurement.
    const result = await executeQuery(
      "SELECT area_m2, length_m FROM step_measured",
    );
    expect(near(Number(result.preview[0].area_m2), Math.PI * 500 * 500))
      .toBeLessThan(0.02);
    expect(near(Number(result.preview[0].length_m), 2 * Math.PI * 500))
      .toBeLessThan(0.02);

    // And the step's output records where it measured, as a one-off's does.
    const measurement = getTableByName("step_ring")!.sourceParams
      ?.measurement as { crs?: Record<string, string> };
    expect(measurement?.crs?.distance).toBe("EPSG:32633");
  }, 180_000);
});

describe("a measurement is pinned to the data it was prepared for", () => {
  it("refuses rather than apply a stale projection to newer data", async () => {
    // A metric run resolves its CRS at admission, because the refusal has to
    // be an admission refusal — and the job can then wait in the lane while
    // the input is replaced. Applying the old generation's projection to the
    // new data would publish a measurably wrong number and record a CRS
    // describing neither, with nothing downstream to notice.
    const table = getTableByName("berlin")!;
    await expect(
      materialize(testAccountScope(), {
        sql: `SELECT geometry FROM berlin`,
        name: "pinned_out",
        operation: "buffer",
        // Where it measured, as the lane records it — and J10 that is what
        // makes this refusal the measurement-flavoured one. A run that measured
        // nothing is told plainly that its input changed instead.
        measurement: { crs: { distance: "EPSG:32633" }, fallback: false },
        // What the run was compiled for, and not what it will find.
        requireBindings: { berlin: "tables/a-generation-that-is-gone.parquet" },
      }),
    ).rejects.toMatchObject({ code: "measurement_crs_unavailable" });

    // Nothing written, and the input untouched.
    expect(getTableByName("pinned_out")).toBeNull();
    expect(getTableByName("berlin")!.file).toBe(table.file);
  }, 120_000);
});

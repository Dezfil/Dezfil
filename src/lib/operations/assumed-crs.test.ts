import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { getJob } from "@/lib/metadata/jobs";
import { getTableByName, updateTableData } from "@/lib/metadata/tables";
import { jobView } from "./job-view";
import { startRun } from "./run";
import { laneSettled, resetLane } from "./lane";
import { POST as runOperation } from "@/app/api/operations/run/route";

/**
 * The crs-assumed gate.
 *
 * The flag has existed since import and has had **no consumer in the query
 * path**: a table whose coordinate columns were never really longitude and
 * latitude is otherwise indistinguishable to an operation from a declared
 * source. It renders somewhere, which usually looks fine, and a metric
 * operation measures it and answers in metres with a straight face.
 *
 * **It is a warning, not a refusal** (G1). A CSV with longitude and latitude
 * columns — the commonest import in this product — is *always* assumed, so
 * refusing would block the core loop for every uploaded file to prevent a
 * rarer mistake.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const file = path.join(dir, "guessed.csv");
  await writeFile(file, "name,lon,lat\nalex,13.405,52.52\n");
  await ingestFile(file, "guessed.csv");
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  new Request("http://test/api/operations/run", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** A CSV's coordinate columns are always an assumption — that is the point. */
const buffer = (name: string) => ({
  operation: "buffer",
  parameters: { input: "guessed", distance: 500, name },
});

describe("said before the run", () => {
  it("reports the assumption on the dry run", async () => {
    const response = await runOperation(post({ ...buffer("x"), dryRun: true }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings?: string[] };
    expect(body.warnings?.join(" ")).toMatch(/without a declared coordinate system/i);
    expect(body.warnings?.join(" ")).toContain("guessed");
  }, 60_000);

  it("reports it on the answer that accepts the run, and still accepts it", async () => {
    const job = await startRun(buffer("accepted_out"));
    // Accepted, not refused: G1's whole ruling.
    expect(["queued", "running"]).toContain(job.state);
    expect(jobView(job).warnings?.join(" ")).toMatch(/WGS84 was assumed/i);
    await laneSettled();
    expect(getJob(job.id)!.state).toBe("succeeded");
  }, 60_000);
});

describe("recorded on the output", () => {
  it("records the assumption AND the measurement CRS, not one of the two", async () => {
    const job = await startRun(buffer("recorded_out"));
    await laneSettled();
    expect(getJob(job.id)!.state).toBe("succeeded");

    const measurement = getTableByName("recorded_out")!.sourceParams
      ?.measurement as { crs?: Record<string, string>; assumedCrs?: string[] };
    // A conjunctive claim, so both halves are asserted: a record naming the
    // CRS but not the assumption would let a guessed measurement read as a
    // declared one.
    expect(measurement?.crs?.distance).toBe("EPSG:32633");
    expect(measurement?.assumedCrs).toEqual(["guessed"]);
  }, 60_000);
});

describe("absent for a declared input", () => {
  it("says nothing when the coordinate system was declared", async () => {
    // The flag must not be decoration that is always on: a table whose CRS was
    // declared carries no assumption, and its measurement says so.
    const table = getTableByName("guessed")!;
    updateTableData(
      { name: table.name, id: table.id },
      {
        file: table.file,
        geometryColumn: table.geometryColumn,
        geometryType: table.geometryType,
        crsAssumed: false,
        headerSuspect: false,
        rowCount: table.rowCount,
        importedAt: table.importedAt ?? new Date().toISOString(),
      },
    );

    const job = await startRun(buffer("declared_out"));
    expect(jobView(job).warnings).toBeUndefined();
    await laneSettled();

    const measurement = getTableByName("declared_out")!.sourceParams
      ?.measurement as { assumedCrs?: string[] };
    expect(measurement?.assumedCrs).toEqual([]);
  }, 60_000);
});

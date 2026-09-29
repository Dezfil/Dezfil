import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { executeQuery } from "@/lib/query/execute";
import { getTableByName } from "@/lib/metadata/tables";
import { getJob, listJobs } from "@/lib/metadata/jobs";
import { addStep, createRecipe, editStep, getStep } from "@/lib/metadata/recipes";
import { edgesForStep } from "@/lib/metadata/lineage";
import { startRun } from "./run";
import { startStepRun } from "./step-execution";
import { retirementsSettled } from "@/lib/ingest/retire";
import { laneSettled, resetLane } from "./lane";

/**
 * A step's run, end to end.
 *
 * These exercise the whole path — compile the verb, admit it, run it on the
 * lane, publish ownership and lineage in one commit — because every part of it
 * that is interesting is a *join* between pieces that each test green alone:
 * the admission exception is only meaningful against the refusal it excepts,
 * and lineage is only right if the SQL the verb generated is what was parsed.
 */

let dir: string;
let recipeId: string;

/** Zones A–D, 10 wide, along the x axis. */
const ZONES = `name,wkt,pop
A,"POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))",100
B,"POLYGON((10 0, 20 0, 20 10, 10 10, 10 0))",200
C,"POLYGON((20 0, 30 0, 30 10, 20 10, 20 0))",300
D,"POLYGON((30 0, 40 0, 40 10, 30 10, 30 0))",400
`;

/** A ← 3, B ← 1, C ← 0, D ← 2. */
const POINTS = `label,lon,lat,value
p1,1,1,1
p2,2,2,2
p3,3,3,6
p4,11,1,10
p5,31,1,4
p6,32,2,4
`;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();

  const zones = path.join(dir, "zones.csv");
  await writeFile(zones, ZONES);
  await ingestFile(testAccountScope(), zones, "zones.csv");
  const points = path.join(dir, "points.csv");
  await writeFile(points, POINTS);
  await ingestFile(testAccountScope(), points, "points.csv");

  recipeId = createRecipe(testAccountScope(), "R").id;
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const sqlStep = (sql: string, name: string) =>
  addStep(recipeId, { operation: "sql_step", parameters: { sql, name } });

const joinStep = (name: string, carry: unknown[]) =>
  addStep(recipeId, {
    operation: "spatial_join",
    parameters: {
      left: "zones",
      right: "points",
      predicate: "contains",
      carry,
      name,
    },
  });

async function runStep(stepId: string) {
  const job = await startStepRun(testAccountScope(), stepId);
  await laneSettled();
  return getJob(job.id)!;
}

describe("a SQL step's run", () => {
  it("publishes, and records what it owns and what it read", async () => {
    const step = sqlStep("SELECT name, pop FROM zones", "big_zones");
    const job = await runStep(step.id);

    expect(job.state).toBe("succeeded");
    expect(job.outputName).toBe("big_zones");
    // Ownership, from the run — this is what later admits a re-run.
    const after = getStep(step.id)!;
    expect(after.outputTableId).toBe(job.outputId);
    expect(after.outputTableName).toBe("big_zones");
    // And its lineage, from the parse of the SQL that actually ran.
    expect(edgesForStep(testAccountScope(), step.id).map((e) => e.inputTableName)).toEqual(["zones"]);
    expect(
      Number((await executeQuery("SELECT count(*) AS n FROM big_zones")).preview[0].n),
    ).toBe(4);
  }, 60_000);

  it("groups its runs under the step, so its history is its own", async () => {
    const step = sqlStep("SELECT 1 AS n", "hist_out");
    await runStep(step.id);
    expect(listJobs({ subjectId: step.id })).toHaveLength(1);
  }, 60_000);
});

describe("a spatial join's run", () => {
  it("records the caller's non-scalar parameters, not a reduction of them", async () => {
    const carry = [
      { aggregate: "count" },
      { aggregate: "sum", field: "value", as: "value_total" },
    ];
    const step = joinStep("enriched", carry);
    const job = await runStep(step.id);

    expect(job.state).toBe("succeeded");
    // What the run records is what was sent. A path that flattened the verb to
    // a SQL string and a name would answer `{sql, name}` here.
    expect(job.parameters?.carry).toEqual(carry);
    expect(job.parameters?.predicate).toBe("contains");
  }, 60_000);

  it("gives BOTH inputs a lineage edge", async () => {
    const step = joinStep("enriched", [{ aggregate: "count" }]);
    await runStep(step.id);

    // The right input's table is named only inside a correlated subquery, so
    // an implementation reading dependencies from the outer FROM alone finds
    // one edge here and would leave a refresh of `points` unnoticed.
    expect(edgesForStep(testAccountScope(), step.id).map((e) => e.inputTableName).sort()).toEqual([
      "points",
      "zones",
    ]);
  }, 60_000);

  it("produces one row per left feature, with the known answers", async () => {
    const step = joinStep("enriched", [{ aggregate: "count" }]);
    await runStep(step.id);

    const result = await executeQuery("SELECT name, match_count FROM enriched");
    expect(result.rowCount).toBe(4);
    expect(
      Object.fromEntries(
        result.preview.map((r) => [r.name as string, Number(r.match_count)]),
      ),
    ).toEqual({ A: 3, B: 1, C: 0, D: 2 });
  }, 60_000);
});

describe("re-running in place", () => {
  it("keeps the output's id and name, and readers see the new data", async () => {
    const step = sqlStep("SELECT 1 AS n", "in_place");
    const first = await runStep(step.id);
    const firstId = getTableByName("in_place")!.id;

    // A layer's SQL names the table, not the run — this is the whole point of
    // keeping identity across a re-run.
    const reader = "SELECT n FROM in_place";
    expect((await executeQuery(reader)).preview[0].n).toBe(1);

    editStep(step.id, { sql: "SELECT 2 AS n", name: "in_place" });
    const second = await runStep(step.id);

    expect(second.state).toBe("succeeded");
    expect(second.id).not.toBe(first.id);
    const table = getTableByName("in_place")!;
    expect(table.id).toBe(firstId);
    expect(second.outputId).toBe(firstId);
    expect((await executeQuery(reader)).preview[0].n).toBe(2);
    // And the proposal became what the step means, now that a run of it worked.
    expect(getStep(step.id)!.parameters).toEqual({
      sql: "SELECT 2 AS n",
      name: "in_place",
    });
  }, 90_000);

  it("registers afresh when a proposal renames the output, leaving the old table", async () => {
    const step = sqlStep("SELECT 1 AS n", "original");
    await runStep(step.id);
    const originalId = getTableByName("original")!.id;

    editStep(step.id, { sql: "SELECT 1 AS n", name: "renamed" });
    const job = await runStep(step.id);

    expect(job.state).toBe("succeeded");
    expect(job.outputName).toBe("renamed");
    // A rename is not a replacement: nothing moved a table other layers point
    // at, and the step now owns the new one.
    expect(getTableByName("original")!.id).toBe(originalId);
    expect(getStep(step.id)!.outputTableName).toBe("renamed");
  }, 90_000);
});

describe("the admission exception cannot be forged", () => {
  it("refuses a run that imitates a step's grouping identity", async () => {
    const step = sqlStep("SELECT 1 AS n", "owned_out");
    await runStep(step.id);
    const before = listJobs().length;

    // The caller sends the step's own subject — grouping identity, which any
    // client may send — and asks for the name that step owns. Ownership is a
    // stored fact about the step, so this is an ordinary taken name.
    await expect(
      startRun(testAccountScope(), {
        operation: "sql_step",
        parameters: { sql: "SELECT 99 AS n", name: "owned_out" },
        subject: step.id,
      }),
    ).rejects.toMatchObject({ code: "name_taken", status: 409 });

    // No job at all, and the step's data untouched.
    expect(listJobs()).toHaveLength(before);
    expect((await executeQuery("SELECT n FROM owned_out")).preview[0].n).toBe(1);
  }, 60_000);

  it("still refuses a taken name for a step that owns nothing", async () => {
    const owner = sqlStep("SELECT 1 AS n", "someones_table");
    await runStep(owner.id);

    const other = sqlStep("SELECT 2 AS n", "someones_table");
    await expect(startStepRun(testAccountScope(), other.id)).rejects.toMatchObject({
      code: "name_taken",
    });
  }, 60_000);
});

describe("an in-place re-run does not strand the generation it replaced", () => {
  it("retires the old artifact rather than leaving it for the boot sweep", async () => {
    const step = sqlStep("SELECT 1 AS n", "retired_out");
    await runStep(step.id);
    const before = getTableByName("retired_out")!.file;

    editStep(step.id, { sql: "SELECT 2 AS n", name: "retired_out" });
    await runStep(step.id);
    const after = getTableByName("retired_out")!.file;
    expect(after).not.toBe(before);

    // Retirement waits for the readers in flight when it was scheduled, so
    // the removal is observed after they settle rather than immediately.
    await retirementsSettled();

    // Without this, every re-run leaks a full dataset until the process
    // restarts — which routine work over a large output turns into a full disk.
    const files = await readdir(path.join(dir, "data", "tables"));
    expect(files).not.toContain(path.basename(before));
    expect(files).toContain(path.basename(after));
  }, 120_000);
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { register } from "@/instrumentation";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { getTableByName, type DataTable } from "@/lib/metadata/tables";
import { getJob, insertJob, listJobs, type OperationJob } from "@/lib/metadata/jobs";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import {
  createCascade,
  finishCascade,
  getCascade,
  setMember,
} from "@/lib/metadata/cascades";
import { startRun } from "./run";
import { laneSettled, laneDepth, resetLane } from "./lane";

/**
 * Startup reconciliation.
 *
 * These drive `register()` — the hook the server's own startup awaits — rather
 * than the reconciler. That distinction is the criterion: a test that called
 * the reconciler directly would stay green if nothing ever invoked it, which is
 * the defect worth catching. What the hook does *before requests are served* is
 * the framework's ordering, verified against the pinned server source rather
 * than here.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  process.env.NEXT_RUNTIME = "nodejs";
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(src, "stations.csv");
  await boundedEvaluation(async () => undefined);
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.NEXT_RUNTIME;
  await rm(dir, { recursive: true, force: true });
});

/** A job row a stopped process would have left behind. */
function stranded(state: "queued" | "running"): OperationJob {
  const id = randomUUID();
  return {
    id,
    subjectKind: "run",
    subjectId: id,
    operation: "sql_step",
    parameters: { sql: "SELECT 1 AS n", name: "would_have_been" },
    state,
    errorCode: null,
    errorMessage: null,
    outputId: null,
    outputName: null,
    acceptedAt: new Date().toISOString(),
    startedAt: state === "running" ? new Date().toISOString() : null,
    finishedAt: null,
  };
}

describe("a restart settles what the lane was holding", () => {
  it("settles both queued and running rows through the startup hook", async () => {
    const queued = stranded("queued");
    const running = stranded("running");
    insertJob(queued);
    insertJob(running);

    await register();

    for (const id of [queued.id, running.id]) {
      const after = getJob(id)!;
      expect(after.state).toBe("failed");
      expect(after.errorCode).toBe("operation_interrupted");
      expect(after.finishedAt).toBeTruthy();
    }
  });

  it("tells each one the truth about itself", async () => {
    const queued = stranded("queued");
    const running = stranded("running");
    insertJob(queued);
    insertJob(running);

    await register();

    // A queued run never started, and must not be told it stopped mid-flight.
    expect(getJob(queued.id)!.errorMessage).toMatch(/never ran|before this run started/i);
    expect(getJob(queued.id)!.errorMessage).not.toMatch(/while this run was executing/i);
    // A running one is told exactly that.
    expect(getJob(running.id)!.errorMessage).toMatch(/while this run was executing/i);
  });

  it("re-executes nothing", async () => {
    insertJob(stranded("queued"));
    insertJob(stranded("running"));

    await register();
    await laneSettled();

    // The lane is empty and the output the stranded runs named was never made.
    expect(laneDepth()).toEqual({ executing: 0, waiting: 0 });
    expect(getTableByName("would_have_been")).toBeNull();
  });

  it("is a no-op when nothing was in flight, and idempotent on a second boot", async () => {
    await register();
    expect(listJobs()).toHaveLength(0);

    const done = await startRun({
      operation: "sql_step",
      parameters: { sql: "SELECT 1 AS n", name: "finished" },
    });
    await laneSettled();
    const before = getJob(done.id)!;

    await register();
    expect(getJob(done.id)).toEqual(before);
  }, 30_000);
});

describe("recovery never contradicts what was published", () => {
  it("leaves a succeeded run and its dataset alone", async () => {
    // A run that published crashed *after* publication by definition: success
    // and registration commit together, so there is no other state it could be
    // left in. Seeding that state is faithful to the crash, not a shortcut.
    const job = await startRun({
      operation: "sql_step",
      parameters: { sql: "SELECT name FROM stations", name: "published" },
    });
    await laneSettled();
    const succeeded = getJob(job.id)!;
    expect(succeeded.state).toBe("succeeded");

    await register();

    const after = getJob(job.id)!;
    expect(after.state).toBe("succeeded");
    expect(after.errorCode).toBeNull();
    expect(after.finishedAt).toBe(succeeded.finishedAt);
    // And the committed data is still there — recovery marks, it never deletes.
    expect(getTableByName("published")).not.toBeNull();
  }, 30_000);

  it("settles a run whose output never committed, and sweeps its orphan", async () => {
    // The crash-before-publication state: a running job, and an artifact
    // written but never registered. The boot sweep owns the file; recovery
    // owns the row. Both must happen, and neither may touch the other's.
    const orphan = path.join(dir, "data", "tables", `${randomUUID()}.parquet`);
    await writeFile(orphan, "not really parquet, but unreferenced all the same");
    const running = stranded("running");
    insertJob(running);

    await register();

    expect(getJob(running.id)!.state).toBe("failed");
    expect(getJob(running.id)!.errorCode).toBe("operation_interrupted");
    expect(getTableByName("would_have_been")).toBeNull();
    const left = await readdir(path.join(dir, "data", "tables"));
    expect(left).not.toContain(path.basename(orphan));
  });

  it("does not sweep an artifact a registered table still references", async () => {
    // The other direction of the same sweep — a guard against recovery's
    // neighbour becoming destructive.
    const before = getTableByName("stations") as DataTable;
    await register();
    const after = getTableByName("stations")!;
    expect(after.file).toBe(before.file);
    const left = await readdir(path.join(dir, "data", "tables"));
    expect(left).toContain(path.basename(after.file));
  });
});

/** A guard on the seam itself: recovery must be reachable from the hook. */
describe("the wiring", () => {
  it("is invoked by the startup hook, not merely importable", async () => {
    const running = stranded("running");
    insertJob(running);
    // No direct call to the reconciler anywhere in this test.
    await register();
    expect(getJob(running.id)!.state).toBe("failed");
  });
});

/**
 * A cascade always reaches a terminal outcome.
 *
 * Its drive loop is in-process exactly as the lane is, and unlike a job
 * nothing else would ever settle it — a cascade left active is watchably
 * active forever, which must never happen.
 */
describe("a cascade a stopped process left active", () => {
  it("is settled interrupted, with its completed members still recorded", async () => {
    const recipeId = createRecipe("R").id;
    const done = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT 1 AS n", name: "cascade_done" },
    });
    const wasRunning = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT 2 AS n", name: "cascade_running" },
    });
    const neverStarted = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT 3 AS n", name: "cascade_pending" },
    });

    const cascade = createCascade(recipeId, "run_all", [
      { stepId: done.id, ordinal: 0 },
      { stepId: wasRunning.id, ordinal: 1 },
      { stepId: neverStarted.id, ordinal: 2 },
    ]);
    setMember(cascade.id, done.id, { state: "succeeded", jobId: "job-done" });
    setMember(cascade.id, wasRunning.id, { state: "running", jobId: "job-running" });

    await register();

    const settled = getCascade(cascade.id)!;
    expect(settled.outcome).toBe("interrupted");
    expect(settled.finishedAt).not.toBeNull();
    const byStep = Object.fromEntries(
      settled.members.map((m) => [m.stepId, m.state]),
    );
    // What completed stays completed; nothing is resumed.
    expect(byStep[done.id]).toBe("succeeded");
    expect(byStep[wasRunning.id]).toBe("failed");
    expect(byStep[neverStarted.id]).toBe("not_run");
  });

  it("leaves a cascade that already settled exactly as it was", async () => {
    const recipeId = createRecipe("R").id;
    const only = addStep(recipeId, {
      operation: "sql_step",
      parameters: { sql: "SELECT 1 AS n", name: "cascade_terminal" },
    });
    const cascade = createCascade(recipeId, "run_all", [
      { stepId: only.id, ordinal: 0 },
    ]);
    setMember(cascade.id, only.id, { state: "succeeded", jobId: "job-x" });
    finishCascade(cascade.id, "completed", new Date().toISOString());
    const before = getCascade(cascade.id)!;

    await register();

    expect(getCascade(cascade.id)).toEqual(before);
  });
});

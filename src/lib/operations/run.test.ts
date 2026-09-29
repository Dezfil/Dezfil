import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { ApiError } from "@/lib/api/errors";
import { getTableByName, insertTable } from "@/lib/metadata/tables";
import { getJob, listJobs, finish } from "@/lib/metadata/jobs";
import { executeQuery } from "@/lib/query/execute";
import { startRun, cancelRun } from "./run";
import { laneSettled, resetLane } from "./lane";

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(
    src,
    "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\nsudkreuz,13.36,52.48\n",
  );
  await ingestFile(testAccountScope(), src, "stations.csv");
  await boundedEvaluation(async () => undefined);
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const sqlStep = (sql: string, name: string, subject?: string) => ({
  operation: "sql_step",
  parameters: { sql, name },
  ...(subject ? { subject } : {}),
});

async function run(sql: string, name: string, subject?: string) {
  const job = await startRun(testAccountScope(), sqlStep(sql, name, subject));
  await laneSettled();
  return getJob(job.id)!;
}

describe("the admission boundary", () => {
  /**
   * The spec's table, driven in both directions. The left column must refuse
   * without minting; the right must be accepted and reported on the job. A case
   * that migrates across the line fails this.
   */
  const refusedAtAdmission: [string, unknown, string][] = [
    ["an unknown operation", { operation: "no_such_verb", parameters: {} }, "invalid_request"],
    ["a missing sql parameter", { operation: "sql_step", parameters: { name: "x" } }, "invalid_request"],
    ["a missing name parameter", { operation: "sql_step", parameters: { sql: "SELECT 1" } }, "invalid_request"],
    [
      "a non-string subject",
      { operation: "sql_step", parameters: { sql: "SELECT 1", name: "x" }, subject: 7 },
      "invalid_request",
    ],
    [
      "SQL the read-only guard rejects",
      { operation: "sql_step", parameters: { sql: "DROP TABLE stations", name: "x" } },
      "sql_rejected",
    ],
  ];

  for (const [label, request, code] of refusedAtAdmission) {
    it(`refuses ${label} without minting a job`, async () => {
      const before = listJobs().length;
      await expect(startRun(testAccountScope(), request as never)).rejects.toMatchObject({ code });
      expect(listJobs()).toHaveLength(before);
    });
  }

  it("refuses a name already taken, without minting a job", async () => {
    await expect(startRun(testAccountScope(), sqlStep("SELECT 1 AS n", "stations"))).rejects.toMatchObject({
      code: "name_taken",
    });
    expect(listJobs()).toHaveLength(0);
  });

  const reportedOnTheJob: [string, string, string][] = [
    ["SQL that parses but cannot bind", "SELECT missing_column FROM stations", "sql_error"],
  ];

  for (const [label, sql, code] of reportedOnTheJob) {
    it(`accepts ${label} and reports it on the job`, async () => {
      const job = await run(sql, "derived");
      expect(job.state).toBe("failed");
      expect(job.errorCode).toBe(code);
      // Accepted means a job exists — the other side of the boundary.
      expect(listJobs()).toHaveLength(1);
    });
  }
});

describe("a run's outcome", () => {
  it("succeeds, names its output, and the dataset is queryable", async () => {
    const job = await run("SELECT name FROM stations", "just_names");

    expect(job.state).toBe("succeeded");
    expect(job.outputName).toBe("just_names");
    expect(job.outputId).toBeTruthy();
    expect(job.errorCode).toBeNull();
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();

    const registered = getTableByName("just_names")!;
    expect(registered.id).toBe(job.outputId);
    const back = await executeQuery("SELECT count(*) AS n FROM just_names");
    expect(Number(back.preview[0].n)).toBe(3);
  }, 30_000);

  it("is queued before it runs, and carries no start time then", async () => {
    const job = await startRun(testAccountScope(), sqlStep("SELECT 1 AS n", "later"));
    expect(job.state).toBe("queued");
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    await laneSettled();
  }, 30_000);

  it("keeps a geometryless result — the case with no other terminal action", async () => {
    const job = await run("SELECT count(*) AS n FROM stations", "just_a_count");
    expect(job.state).toBe("succeeded");
    expect(getTableByName("just_a_count")!.geometryColumn).toBeNull();
  }, 30_000);

  it("is its own subject when the caller supplies none, and shares one when they do", async () => {
    const alone = await run("SELECT 1 AS n", "alone");
    expect(alone.subjectKind).toBe("run");
    expect(alone.subjectId).toBe(alone.id);

    await run("SELECT 1 AS n", "shared_one", "my-step");
    await run("SELECT missing FROM stations", "shared_two", "my-step");
    const history = listJobs({ subjectId: "my-step" });
    expect(history).toHaveLength(2);
    expect(history.every((j) => j.subjectKind === "client")).toBe(true);
  }, 60_000);

  it("a failed re-run does not erase the last success", async () => {
    const good = await run("SELECT 1 AS n", "good_output", "step-7");
    const bad = await run("SELECT nope FROM stations", "bad_output", "step-7");
    expect(good.state).toBe("succeeded");
    expect(bad.state).toBe("failed");

    const history = listJobs({ subjectId: "step-7" });
    const success = history.find((j) => j.state === "succeeded");
    expect(success).toBeDefined();
    expect(success!.finishedAt).toBe(good.finishedAt);
  }, 60_000);
});

describe("a name taken between admission and commit", () => {
  const SLOW =
    "SELECT a.range AS n FROM range(40000) a, range(40000) b WHERE (a.range * b.range) % 7 = 3";

  it("fails as name_taken from the commit, not from admission", async () => {
    // The commit-race branch, which the admission tests cannot reach: the name
    // is free when the run is accepted and taken by the time it commits. A
    // regression mapping this to `internal` would otherwise stay green.
    const tables = path.join(dir, "data", "tables");
    const before = new Set(await readdir(tables));
    const job = await startRun(testAccountScope(), sqlStep(SLOW, "claimed_late"));

    // Wait until the run has begun writing its artifact. Claiming the name
    // earlier would be caught by the materializer's own pre-work check, which
    // is the same branch the admission tests already cover — the commit race
    // is only reached once that check has passed.
    const deadline = Date.now() + 60_000;
    while (!(await readdir(tables)).some((f) => !before.has(f))) {
      if (Date.now() > deadline) throw new Error("the run never began writing");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(getJob(job.id)!.state).toBe("running");

    // Now claim it, from under a run that has already passed its own check.
    insertTable(testAccountScope(), {
      id: "usurper",
      name: "claimed_late",
      sourceFilename: "other.csv",
      format: "csv",
      file: "tables/usurper.parquet",
      geometryColumn: null,
      geometryType: null,
      crsAssumed: false,
      headerSuspect: false,
      rowCount: 1,
      createdAt: new Date().toISOString(),
      source: "upload",
      sourceParams: null,
      importedAt: null,
    });

    await laneSettled();

    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    expect(settled.errorCode).toBe("name_taken");
    // The table on that name is still the other one — the run wrote nothing.
    expect(getTableByName("claimed_late")!.id).toBe("usurper");
  }, 120_000);
});

describe("a full queue", () => {
  // Long enough that the blocker is certainly still executing while the rest
  // are admitted; cancelled at the end rather than waited out.
  const ENDLESS =
    "SELECT count(*) AS n FROM range(200000) a, range(200000) b WHERE (a.range * b.range) % 7 = 3";

  it("refuses with the coded error and mints no job at all", async () => {
    process.env.DEZFIL_OPERATION_CONCURRENCY = "1";
    process.env.DEZFIL_OPERATION_QUEUE_MAX = "1";
    try {
      const blocker = await startRun(testAccountScope(), sqlStep(ENDLESS, "blocked_out"));
      const queued = await startRun(testAccountScope(), sqlStep("SELECT 1 AS n", "waiting"));
      const before = listJobs().length;
      expect(before).toBe(2);

      await expect(startRun(testAccountScope(), sqlStep("SELECT 1 AS n", "refused"))).rejects.toMatchObject({
        code: "operation_queue_full",
        status: 503,
      });

      // Neither a queued row nor a terminal failed one: the server never took
      // responsibility for this work, so it leaves no record of it.
      expect(listJobs()).toHaveLength(before);
      expect(listJobs().some((j) => j.parameters?.name === "refused")).toBe(false);

      await cancelRun(queued.id);
      await cancelRun(blocker.id);
      await laneSettled();
    } finally {
      delete process.env.DEZFIL_OPERATION_CONCURRENCY;
      delete process.env.DEZFIL_OPERATION_QUEUE_MAX;
    }
  }, 120_000);
});

describe("cancellation", () => {
  it("answers not_found for an unknown run", async () => {
    await expect(cancelRun("nope")).rejects.toBeInstanceOf(ApiError);
    await expect(cancelRun("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns a terminal job unchanged and raises nothing (G5)", async () => {
    const job = await run("SELECT 1 AS n", "done_already");
    const after = await cancelRun(job.id);
    expect(after.state).toBe("succeeded");
    expect(after.finishedAt).toBe(job.finishedAt);
  }, 30_000);

  it("removes a COMPLETED artifact when the run lost authority", async () => {
    // The case our own cleanup is answerable for. The query is fast, so its
    // COPY finishes and a fully written artifact exists; only then is the run
    // denied publication. Interrupting mid-write proves nothing here — the
    // engine discards its own partial output, so that path stays green even
    // with our cleanup removed.
    const tables = path.join(dir, "data", "tables");
    const before = new Set(await readdir(tables));

    const job = await startRun(testAccountScope(), sqlStep("SELECT name FROM stations", "authority_lost"));
    // Take the run's authority away while it works; the commit's conditional
    // update then refuses, and the finished artifact is ours to remove.
    finish(job.id, { state: "cancelled" }, new Date().toISOString());
    await laneSettled();

    expect(getJob(job.id)!.state).toBe("cancelled");
    expect(getTableByName("authority_lost")).toBeNull();
    const leftover = (await readdir(tables)).filter((f) => !before.has(f));
    expect(leftover).toEqual([]);
  }, 60_000);

  it("a cancelled run leaves no dataset and no stranded artifact", async () => {
    // Long enough that the cancel lands while the artifact is being written.
    const SLOW =
      "SELECT a.range AS n FROM range(40000) a, range(40000) b WHERE (a.range * b.range) % 7 = 3";
    const tables = path.join(dir, "data", "tables");
    const before = new Set(await readdir(tables));

    const job = await startRun(testAccountScope(), sqlStep(SLOW, "never_lands"));

    // Wait until the run has actually put a candidate artifact on disk. A
    // cancel before that point would exercise nothing: there would be no file
    // whose removal could be asserted, and a leak would stay green.
    let candidate: string | undefined;
    const deadline = Date.now() + 60_000;
    while (!candidate) {
      if (Date.now() > deadline) throw new Error("no candidate artifact ever appeared");
      candidate = (await readdir(tables)).find((f) => !before.has(f));
      if (!candidate) await new Promise((r) => setTimeout(r, 50));
    }

    await cancelRun(job.id);
    await laneSettled();

    const after = getJob(job.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.errorCode).toBeNull();
    expect(after.outputName).toBeNull();
    expect(getTableByName("never_lands")).toBeNull();
    // That exact file — observed to exist — is gone.
    expect(await readdir(tables)).not.toContain(candidate);
  }, 120_000);
});

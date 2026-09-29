import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { executeQuery } from "@/lib/query/execute";
import { getJob, listJobs, TERMINAL_STATES } from "@/lib/metadata/jobs";
import { getTableByName } from "@/lib/metadata/tables";
import { addStep, createRecipe, editStep, removeStep } from "@/lib/metadata/recipes";
import type { CascadeRun } from "@/lib/metadata/cascades";
import {
  cancelCascade,
  cascadeSettled,
  planCascade,
  readCascade,
  startCascade,
  startSingleRun,
} from "./cascade";
import { listCascades } from "@/lib/metadata/cascades";
import { startStepRun } from "./step-execution";
import { isExecuting, laneSettled, resetLane } from "./lane";
import { cancelRun } from "./run";
import { ApiError } from "@/lib/api/errors";
import { recoverInterruptedCascades } from "./recover";

/**
 * The cascade.
 *
 * Two things these are built to catch. **Ordering that passes by luck**: at the
 * default concurrency of one, arrival order and dependency order coincide, so a
 * planner that simply submitted everything would be green. Every ordering case
 * here runs with the lane's concurrency raised above one. And **a member that
 * quietly mints a job it should never have minted** — `not_run` is a member's
 * condition, and a sixth job state arriving by the back door is exactly what
 * contract forbids.
 */

let dir: string;
let recipeId: string;

/** Minutes of work: "settled in seconds" is then decisive, not marginal. */
const ENDLESS =
  "SELECT count(*) AS n FROM range(200000) a, range(200000) b " +
  "WHERE (a.range * b.range) % 7 = 3";

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  // Above one, so dependency order cannot be an accident of queue position.
  process.env.DEZFIL_OPERATION_CONCURRENCY = "4";
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalex,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  await boundedEvaluation(async () => undefined);
  recipeId = createRecipe(testAccountScope(), "R").id;
});

afterEach(async () => {
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_OPERATION_CONCURRENCY;
  await rm(dir, { recursive: true, force: true });
});

const step = (sql: string, name: string) =>
  addStep(recipeId, { operation: "sql_step", parameters: { sql, name } });

async function runAll(fromStepId?: string) {
  const cascade = await startCascade(testAccountScope(), {
    recipeId,
    ...(fromStepId ? { fromStepId } : {}),
  });
  await cascadeSettled(cascade.id);
  return readCascade(cascade.id);
}

const memberOf = (c: CascadeRun, stepId: string) =>
  c.members.find((m) => m.stepId === stepId)!;

describe("run all", () => {
  it("runs a whole recipe in dependency order and reports every output", async () => {
    const one = step("SELECT count(*) AS n FROM stations", "cas_one");
    const two = step("SELECT n * 10 AS n FROM cas_one", "cas_two");
    const three = step("SELECT n + 1 AS n FROM cas_two", "cas_three");

    const cascade = await runAll();

    expect(cascade.outcome).toBe("completed");
    expect(cascade.members.map((m) => m.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    // Every output it produced, named.
    expect(cascade.outputs.map((o) => o.name).sort()).toEqual([
      "cas_one",
      "cas_three",
      "cas_two",
    ]);

    // Dependency order, with the lane free to interleave: each member started
    // only after the one it reads had finished.
    const at = (stepId: string) => getJob(memberOf(cascade, stepId).jobId!)!;
    expect(at(two.id).startedAt! >= at(one.id).finishedAt!).toBe(true);
    expect(at(three.id).startedAt! >= at(two.id).finishedAt!).toBe(true);

    // And the arithmetic only works out if they really ran in that order.
    expect(Number((await executeQuery("SELECT n FROM cas_three")).preview[0].n)).toBe(21);
  }, 180_000);

  it("mints only jobs in the five states published", async () => {
    step("SELECT 1 AS n", "states_one");
    step("SELECT n FROM states_one", "states_two");
    await runAll();

    // Written out rather than compared to "the documented set": comparing to
    // the union would pass if a sixth were added to code and document together.
    const five = ["queued", "running", "succeeded", "failed", "cancelled"];
    // Guarded, because a loop over an empty list asserts nothing at all — the
    // vacuous form of exactly this check.
    expect(listJobs().length).toBeGreaterThan(0);
    for (const job of listJobs()) expect(five).toContain(job.state);
    expect([...TERMINAL_STATES].sort()).toEqual(
      ["cancelled", "failed", "succeeded"].sort(),
    );
  }, 120_000);
});

describe("a failed member", () => {
  it("is not attempted downstream, mints no job, and names what stopped it", async () => {
    // Parses as a read-only SELECT, so it is admitted; the conversion fails
    // only when rows are read. An admission refusal would prove a different
    // branch.
    const bad = step("SELECT CAST(name AS INTEGER) AS n FROM stations", "bad_one");
    const blocked = step("SELECT n FROM bad_one", "bad_two");
    const independent = step("SELECT count(*) AS n FROM stations", "indep_out");

    const cascade = await runAll();

    expect(cascade.outcome).toBe("partly_completed");
    expect(memberOf(cascade, bad.id).state).toBe("failed");

    const stopped = memberOf(cascade, blocked.id);
    expect(stopped.state).toBe("not_run");
    expect(stopped.stoppedBy).toBe(bad.id);
    // No job at all — `not_run` is a member's condition, never a job state.
    expect(stopped.jobId).toBeNull();
    expect(listJobs({ subjectId: blocked.id })).toEqual([]);
    expect(getTableByName("bad_two")).toBeNull();

    // A branch that depends on nothing broken still runs.
    expect(memberOf(cascade, independent.id).state).toBe("succeeded");
    expect(getTableByName("indep_out")).not.toBeNull();
  }, 180_000);

  it("keeps the server's sentence for a member refused before any job", async () => {
    // Refused at *admission* — the input is not a table — so no job is minted
    // and the only channel that could carry the reason is the member row.
    // This kept `not_found` and threw the sentence away, so a stopped run
    // could never say which input it meant.
    const refused = addStep(recipeId, {
      operation: "buffer",
      parameters: { input: "no_such_table", distance: 10, name: "ref_out" },
    });
    const independent = step("SELECT count(*) AS n FROM stations", "ref_indep");

    const cascade = await runAll();

    const member = memberOf(cascade, refused.id);
    expect(member.state).toBe("failed");
    expect(member.jobId).toBeNull();
    expect(member.stoppedBy).toBe("not_found");
    // The half a user can act on: which table is missing, by name.
    expect(member.stoppedReason).toMatch(/no_such_table/);

    // An independent branch is untouched by it.
    expect(memberOf(cascade, independent.id).state).toBe("succeeded");
  }, 180_000);

  it("an unexpected admission failure stores the documented sentence, never its own", async () => {
    // The boundary (harvest): the member row is durable and API-exposed, so
    // a non-coded failure's raw message — which can carry paths and
    // internals — must not be persisted. Seeded by making admission itself
    // blow up with a plain Error.
    step("SELECT count(*) AS n FROM stations", "leak_probe");
    const stepExecution = await import("./step-execution");
    const spy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockRejectedValue(new Error("ENOENT /private/var/secrets/meta.sqlite"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cascade = await runAll();
      const member = cascade.members[0];
      expect(member.state).toBe("failed");
      expect(member.stoppedBy).toBe("internal");
      expect(member.stoppedReason).toBe("An unexpected server error occurred.");
      expect(member.stoppedReason).not.toContain("/private");
      // The detail is logged, not lost.
      expect(quiet).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
  }, 180_000);
});

describe("a coordinator metadata failure", () => {
  it("does not make the parent terminal over admitted engine work", async () => {
    const slow = step(ENDLESS, "n118_slow");
    const quick = step("SELECT 1 AS n", "n118_quick");
    const stepExecution = await import("./step-execution");
    const originalStart = stepExecution.startStepRun;
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admissionSpy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockImplementation(async (_scope, stepId, options) => {
        if (stepId === quick.id) {
          admissionEntered();
          await admissionHeld;
        }
        return originalStart(_scope, stepId, options);
      });

    const cascadeMetadata = await import("@/lib/metadata/cascades");
    const originalGetCascade = cascadeMetadata.getCascade;
    let faultArmed = false;
    let faultConsumptions = 0;
    let slowStateAtConsumption: string | null = null;
    let memberStatesAtConsumption: string[] = [];
    let slowJobId: string | null = null;
    const metadataSpy = vi
      .spyOn(cascadeMetadata, "getCascade")
      .mockImplementation((...args) => {
        if (faultArmed && faultConsumptions === 0) {
          const current = originalGetCascade(...args);
          faultConsumptions += 1;
          slowStateAtConsumption = slowJobId ? (getJob(slowJobId)?.state ?? null) : null;
          memberStatesAtConsumption = current?.members.map((member) => member.state) ?? [];
          throw new Error("injected transient metadata read failure");
        }
        return originalGetCascade(...args);
      });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    let cascade: CascadeRun | undefined;
    try {
      cascade = await startCascade(testAccountScope(), { recipeId });
      await entered;

      const armed = listCascades(recipeId)[0];
      const slowMember = memberOf(armed, slow.id);
      const heldMember = memberOf(armed, quick.id);
      expect(slowMember.state).toBe("running");
      expect(slowMember.jobId).not.toBeNull();
      slowJobId = slowMember.jobId;
      expect(getJob(slowJobId!)?.state).toBe("running");
      expect(heldMember).toMatchObject({ state: "pending", jobId: null });

      // Arm only while the second admission is positively held. Releasing it
      // lets the quick root settle; the next coordinator-owned getCascade is
      // driveCascade's post-settlement member job-id read. The slow-job and
      // member-state controls below distinguish that consumption site.
      faultArmed = true;
      releaseAdmission();
      await cascadeSettled(cascade.id);

      const failed = readCascade(cascade.id);
      expect(faultConsumptions).toBe(1);
      expect(slowStateAtConsumption).toBe("running");
      expect(memberStatesAtConsumption).not.toContain("failed");
      expect(failed.outcome).toBe("failed");
      expect(getJob(slowJobId!)?.state).not.toBe("running");
    } finally {
      releaseAdmission();
      faultArmed = false;
      metadataSpy.mockRestore();
      admissionSpy.mockRestore();
      quiet.mockRestore();
      if (slowJobId && getJob(slowJobId) && getJob(slowJobId)!.state === "running") {
        await cancelRun(testAccountScope(), slowJobId);
      }
      await laneSettled();
    }
  }, 120_000);
});

describe("coordinator failure settlement", () => {
  async function driveFailureRecording(recordingFaults: number, label: string) {
    const slow = step(ENDLESS, `${label}_slow`);
    const quick = step("SELECT 1 AS n", `${label}_quick`);
    const never = step(`SELECT n FROM ${label}_slow`, `${label}_never`);
    const stepExecution = await import("./step-execution");
    const originalStart = stepExecution.startStepRun;
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admissionSpy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockImplementation(async (_scope, stepId, options) => {
        if (stepId === quick.id) {
          admissionEntered();
          await admissionHeld;
        }
        return originalStart(_scope, stepId, options);
      });

    const cascadeMetadata = await import("@/lib/metadata/cascades");
    const originalGetCascade = cascadeMetadata.getCascade;
    let faultArmed = false;
    let faultCalls = 0;
    let slowJobId: string | null = null;
    let slowStateAtDriveFault: string | null = null;
    let statesAtDriveFault: string[] = [];
    const metadataSpy = vi
      .spyOn(cascadeMetadata, "getCascade")
      .mockImplementation((...args) => {
        if (faultArmed) {
          faultCalls += 1;
          if (faultCalls === 1) {
            const current = originalGetCascade(...args);
            slowStateAtDriveFault = slowJobId ? (getJob(slowJobId)?.state ?? null) : null;
            statesAtDriveFault = current?.members.map((member) => member.state) ?? [];
            throw new Error("injected coordinator read failure");
          }
          if (faultCalls <= recordingFaults + 1) {
            throw new Error("injected failure-recording read refusal");
          }
        }
        return originalGetCascade(...args);
      });
    const quietError = vi.spyOn(console, "error").mockImplementation(() => {});
    const quietWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let cascade: CascadeRun | undefined;
    try {
      cascade = await startCascade(testAccountScope(), { recipeId });
      await entered;
      const armed = listCascades(recipeId)[0];
      const slowMember = memberOf(armed, slow.id);
      expect(slowMember.state).toBe("running");
      expect(memberOf(armed, quick.id)).toMatchObject({ state: "pending", jobId: null });
      expect(memberOf(armed, never.id)).toMatchObject({ state: "pending", jobId: null });
      slowJobId = slowMember.jobId;
      expect(getJob(slowJobId!)?.state).toBe("running");

      faultArmed = true;
      releaseAdmission();
      await cascadeSettled(cascade.id);
      await Promise.resolve();
      const faultCallsAtSettlement = faultCalls;
      const run = readCascade(cascade.id);
      return {
        run,
        slow,
        quick,
        never,
        slowJobId: slowJobId!,
        slowStateAtDriveFault,
        statesAtDriveFault,
        faultCallsAtSettlement,
        unhandled: [...unhandled],
        warnings: quietWarn.mock.calls.length,
      };
    } finally {
      releaseAdmission();
      faultArmed = false;
      process.off("unhandledRejection", onUnhandled);
      metadataSpy.mockRestore();
      admissionSpy.mockRestore();
      quietError.mockRestore();
      quietWarn.mockRestore();
      if (slowJobId && getJob(slowJobId)?.state === "running") {
        await cancelRun(testAccountScope(), slowJobId);
      }
      await laneSettled();
    }
  }

  it("retries one failed recording from fresh reads and keeps the whole failed run", async () => {
    const driven = await driveFailureRecording(1, "retry_once");
    expect(driven.slowStateAtDriveFault).toBe("running");
    expect(driven.statesAtDriveFault).not.toContain("failed");
    expect(driven.faultCallsAtSettlement).toBe(3);
    expect(driven.warnings).toBeGreaterThanOrEqual(1);
    expect(driven.unhandled).toEqual([]);

    expect(driven.run.outcome).toBe("failed");
    expect(getJob(driven.slowJobId)?.state).toBe("cancelled");
    expect(memberOf(driven.run, driven.slow.id).attempt?.state).toBe("cancelled");
    expect(memberOf(driven.run, driven.quick.id).state).toBe("succeeded");
    expect(memberOf(driven.run, driven.quick.id).attempt?.state).toBe("succeeded");
    expect(memberOf(driven.run, driven.never.id)).toMatchObject({
      state: "not_run",
      jobId: null,
      attempt: null,
    });
    expect(driven.run.outputs.map((output) => output.name)).toEqual(["retry_once_quick"]);
    expect(getTableByName("retry_once_quick")).not.toBeNull();
    expect(Number((await executeQuery("SELECT n FROM retry_once_quick")).preview[0].n)).toBe(1);
    expect(getTableByName("retry_once_slow")).toBeNull();
    expect(getTableByName("retry_once_never")).toBeNull();

    const terminal = readCascade(driven.run.id);
    await laneSettled();
    expect(readCascade(driven.run.id)).toEqual(terminal);
  }, 120_000);

  it("contains a second recording refusal for restart settlement", async () => {
    const driven = await driveFailureRecording(2, "retry_exhausted");
    expect(driven.slowStateAtDriveFault).toBe("running");
    expect(driven.statesAtDriveFault).not.toContain("failed");
    expect(driven.faultCallsAtSettlement).toBe(3);
    expect(driven.warnings).toBeGreaterThanOrEqual(1);
    expect(driven.unhandled).toEqual([]);
    expect(driven.run.outcome).toBeNull();
    expect(getJob(driven.slowJobId)?.state).toBe("cancelled");

    await expect(startCascade(testAccountScope(), { recipeId })).rejects.toMatchObject({ code: "run_in_flight" });
    expect(recoverInterruptedCascades()).toBe(1);
    const recovered = readCascade(driven.run.id);
    expect(recovered.outcome).toBe("interrupted");
    expect(memberOf(recovered, driven.slow.id).attempt?.state).toBe("cancelled");
    expect(memberOf(recovered, driven.quick.id).attempt?.state).toBe("succeeded");
    expect(memberOf(recovered, driven.never.id)).toMatchObject({
      state: "not_run",
      jobId: null,
      attempt: null,
    });
    expect(recovered.outputs.map((output) => output.name)).toEqual(["retry_exhausted_quick"]);
  }, 120_000);
});

describe("a diamond", () => {
  it("runs a dependent reachable by two paths exactly once", async () => {
    const root = step("SELECT 1 AS n", "d_root");
    const left = step("SELECT n + 1 AS n FROM d_root", "d_left");
    const right = step("SELECT n + 2 AS n FROM d_root", "d_right");
    const join = step(
      "SELECT (SELECT n FROM d_left) + (SELECT n FROM d_right) AS n",
      "d_join",
    );

    const cascade = await runAll(root.id);

    expect(cascade.kind).toBe("from_step");
    expect(cascade.members.map((m) => m.stepId).sort()).toEqual(
      [root.id, left.id, right.id, join.id].sort(),
    );
    expect(cascade.outcome).toBe("completed");
    // Once, not twice: the member set is keyed by step, so a step reachable by
    // two paths is one member.
    expect(listJobs({ subjectId: join.id })).toHaveLength(1);
    expect(Number((await executeQuery("SELECT n FROM d_join")).preview[0].n)).toBe(5);
  }, 180_000);
});

describe("the confirmation property", () => {
  it("is wide for run all and for a re-run that carries dependents", async () => {
    const producer = step("SELECT 1 AS n", "w_one");
    const leaf = step("SELECT n FROM w_one", "w_two");

    expect((await planCascade({ recipeId })).wide).toBe(true);
    expect(
      (await planCascade({ recipeId, fromStepId: producer.id })).wide,
    ).toBe(true);
    // The same control on a leaf — a step nothing reads — carries only itself.
    const onLeaf = await planCascade({ recipeId, fromStepId: leaf.id });
    expect(onLeaf.wide).toBe(false);
    expect(onLeaf.members).toHaveLength(1);
  }, 60_000);
});

describe("cancelling a cascade", () => {
  it("interrupts the running statement early, admits nothing further, and keeps what finished", async () => {
    const quick = step("SELECT 1 AS n", "cancel_done");
    await startStepRun(testAccountScope(), quick.id);
    await laneSettled();

    const slow = step(ENDLESS, "cancel_slow");
    const after = step("SELECT n + 1 AS n FROM cancel_slow", "cancel_never");

    const cascade = await startCascade(testAccountScope(), { recipeId, fromStepId: slow.id });
    // Wait until the slow member is genuinely executing.
    const deadline = Date.now() + 60_000;
    while (
      !readCascade(cascade.id).members.some(
        (m) => m.stepId === slow.id && m.state === "running",
      )
    ) {
      if (Date.now() > deadline) throw new Error("the slow member never started");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(memberOf(readCascade(cascade.id), after.id).state).toBe("pending");

    const started = Date.now();
    const settled = await cancelCascade(testAccountScope(), cascade.id);
    const elapsed = Date.now() - started;

    // The seeded statement is minutes of work. Its *own* settlement in seconds
    // is what says the engine stopped — a prompt follow-up query would prove
    // nothing, since every evaluation gets its own connection.
    expect(elapsed).toBeLessThan(30_000);
    expect(settled.outcome).toBe("cancelled");
    expect(memberOf(settled, slow.id).state).toBe("failed");
    expect(getJob(memberOf(settled, slow.id).jobId!)!.state).toBe("cancelled");
    expect(getTableByName("cancel_slow")).toBeNull();
    expect(readCascade(cascade.id)).toEqual({ ...settled, outputs: [] });

    // Nothing further was admitted…
    const never = memberOf(settled, after.id);
    expect(never.state).toBe("not_run");
    expect(never.jobId).toBeNull();
    // …and what finished before the cascade stands.
    expect(getTableByName("cancel_done")).not.toBeNull();
    expect((await executeQuery("SELECT n FROM cancel_done")).preview[0].n).toBe(1);
  }, 180_000);

  it("is not an error for a cascade that already finished", async () => {
    step("SELECT 1 AS n", "already_done");
    const done = await runAll();
    const again = await cancelCascade(testAccountScope(), done.id);
    expect(again.outcome).toBe("completed");
    expect(again.finishedAt).toBe(done.finishedAt);
    expect(readCascade(done.id)).toEqual(done);
  }, 120_000);
});

describe("cancelling a cascade with more than one member admitted", () => {
  /**
   * Two independent roots on the seeded statement are admitted in one pass,
   * and both are recorded *running* the moment they are — whether the lane
   * executes both, or executes one and holds the other queued. A cancel
   * then has two members in flight, and the record must settle both: a
   * driver that honoured the fence after the first settled left the second
   * `running` in a terminal run.
   */
  async function twoRootsCancelledMidRun() {
    const left = step(ENDLESS, "n85_left");
    const right = step(ENDLESS, "n85_right");
    const cascade = await startCascade(testAccountScope(), { recipeId });
    const deadline = Date.now() + 60_000;
    while (
      readCascade(cascade.id).members.filter((m) => m.state === "running").length < 2
    ) {
      if (Date.now() > deadline) throw new Error("the two roots were never both admitted");
      await new Promise((r) => setTimeout(r, 25));
    }
    const settled = await cancelCascade(testAccountScope(), cascade.id);
    return { settled, left, right };
  }

  async function expectBothRecorded({
    settled,
    left,
    right,
  }: Awaited<ReturnType<typeof twoRootsCancelledMidRun>>) {
    expect(settled.outcome).toBe("cancelled");
    // A terminal run never holds a running member.
    expect(settled.members.map((m) => m.state)).not.toContain("running");
    for (const root of [left, right]) {
      const member = memberOf(settled, root.id);
      // Admitted, then stopped: a failed member whose attempt was cancelled.
      expect(member.state).toBe("failed");
      expect(member.stoppedBy).toBe("cancelled");
      expect(member.jobId).not.toBeNull();
      expect(getJob(member.jobId!)!.state).toBe("cancelled");
      expect(member.attempt?.state).toBe("cancelled");
    }
    expect(getTableByName("n85_left")).toBeNull();
    expect(getTableByName("n85_right")).toBeNull();
    // The attempts are the run's own, not a live read of the jobs: still
    // there once the jobs are gone.
    metadataDb()
      .prepare(`DELETE FROM operation_jobs WHERE id IN (?, ?)`)
      .run(memberOf(settled, left.id).jobId, memberOf(settled, right.id).jobId);
    const reread = readCascade(settled.id);
    expect(memberOf(reread, left.id).attempt?.state).toBe("cancelled");
    expect(memberOf(reread, right.id).attempt?.state).toBe("cancelled");
  }

  it("records every member in flight when the lane executes both", async () => {
    // The file's concurrency (4): both roots execute at once.
    await expectBothRecorded(await twoRootsCancelledMidRun());
  }, 180_000);

  it("records every member in flight at the default concurrency, one executing and one queued", async () => {
    // The default of one: the second root waits in the lane, and is recorded
    // running all the same, so the same two members are in flight.
    delete process.env.DEZFIL_OPERATION_CONCURRENCY;
    await expectBothRecorded(await twoRootsCancelledMidRun());
  }, 180_000);

  it("cancels the one-slot queued member before it enters execution", async () => {
    delete process.env.DEZFIL_OPERATION_CONCURRENCY;
    const left = step(ENDLESS, "n108_left");
    const right = step(ENDLESS, "n108_right");
    const cascade = await startCascade(testAccountScope(), { recipeId });
    const deadline = Date.now() + 60_000;
    let admitted: CascadeRun | undefined;
    while (Date.now() < deadline) {
      const current = readCascade(cascade.id);
      if (current.members.filter((member) => member.state === "running").length === 2) {
        admitted = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(admitted).toBeDefined();

    const jobs = [left, right].map((root) => getJob(memberOf(admitted!, root.id).jobId!)!);
    expect(jobs.map((job) => job.state).sort()).toEqual(["queued", "running"]);
    const queued = jobs.find((job) => job.state === "queued")!;
    const running = jobs.find((job) => job.state === "running")!;
    expect(running.startedAt).not.toBeNull();
    expect(isExecuting(running.id)).toBe(true);
    expect(queued.startedAt).toBeNull();
    expect(isExecuting(queued.id)).toBe(false);

    const settled = await cancelCascade(testAccountScope(), cascade.id);
    const queuedAfter = getJob(queued.id)!;
    expect(settled.outcome).toBe("cancelled");
    expect(queuedAfter.state).toBe("cancelled");
    expect(queuedAfter.startedAt).toBeNull();
    expect(memberOf(settled, left.id).attempt?.state).toBe("cancelled");
    expect(memberOf(settled, right.id).attempt?.state).toBe("cancelled");
    const reread = readCascade(cascade.id);
    expect(reread).toEqual({ ...settled, outputs: [] });
    expect(reread.members.map((member) => member.state)).not.toContain("running");
  }, 180_000);
});

describe("the durable result", () => {
  it("keeps each step's own history and reads back as one record", async () => {
    const one = step("SELECT 1 AS n", "h_one");
    const two = step("SELECT n FROM h_one", "h_two");

    const first = await runAll();
    const second = await runAll();

    expect(first.id).not.toBe(second.id);
    // Per-step history is the step's own; the cascade correlates it.
    expect(listJobs({ subjectId: one.id })).toHaveLength(2);
    expect(listJobs({ subjectId: two.id })).toHaveLength(2);
    // And each cascade is readable long after it finished.
    const reread = readCascade(first.id);
    expect(reread.outcome).toBe("completed");
    expect(reread.finishedAt).not.toBeNull();
    expect(reread.members.map((m) => m.jobId)).not.toContain(null);
  }, 180_000);
});

describe("what the cascade record keeps for itself", () => {
  it("names its outputs after the members' job history has been pruned", async () => {
    // A cascade that read its outputs back from its members' jobs would report
    // none here: history is capped per subject, so re-running enough times
    // evicts the job the cascade was pointing at while the cascade row stays.
    process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "1";
    try {
      const one = step("SELECT 1 AS n", "kept_output_one");
      const first = await runAll();
      expect(first.outcome).toBe("completed");
      expect(first.outputs.map((o) => o.name)).toEqual(["kept_output_one"]);

      // Re-run the step on its own, twice, past the history depth.
      for (let i = 0; i < 3; i += 1) {
        await startStepRun(testAccountScope(), one.id);
        await laneSettled();
      }

      const reread = readCascade(first.id);
      expect(reread.outputs.map((o) => o.name)).toEqual(["kept_output_one"]);
    } finally {
      delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT;
    }
  }, 120_000);

  it("keeps a depth-1 cancelled attempt after job history prunes it", async () => {
    process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "1";
    try {
      const target = step("SELECT 1 AS n", "n109_output");
      const older = await startStepRun(testAccountScope(), target.id);
      await laneSettled();
      expect(getJob(older.id)?.state).toBe("succeeded");

      expect(
        editStep(target.id, { sql: ENDLESS, name: "n109_output" }),
      ).toBe("proposed");
      const cascade = await startSingleRun(testAccountScope(), recipeId, target.id);
      const newerId = memberOf(cascade, target.id).jobId!;
      expect(newerId).not.toBe(older.id);
      expect(getJob(newerId)?.state).toBe("running");

      const settled = await cancelCascade(testAccountScope(), cascade.id);
      const history = listJobs({ subjectId: target.id });
      expect(settled.outcome).toBe("cancelled");
      expect(getJob(newerId)).toBeNull();
      expect(history.map((job) => job.id)).toEqual([older.id]);
      expect(history[0].state).toBe("succeeded");

      const attempt = memberOf(readCascade(cascade.id), target.id).attempt;
      expect(attempt?.state).toBe("cancelled");
      expect(attempt?.acceptedAt).toBeTruthy();
      expect(attempt?.startedAt).toBeTruthy();
      expect(attempt?.finishedAt).toBeTruthy();
      expect(attempt?.output).toBeNull();
    } finally {
      delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT;
    }
  }, 120_000);

  it("keeps a depth-1 attempt when cancellation wins a held single admission", async () => {
    process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "1";
    const target = step("SELECT 1 AS n", "depth_one_single_admission");
    const older = await startStepRun(testAccountScope(), target.id);
    await laneSettled();
    expect(getJob(older.id)?.state).toBe("succeeded");
    expect(
      editStep(target.id, { sql: ENDLESS, name: "depth_one_single_admission" }),
    ).toBe("proposed");

    const stepExecution = await import("./step-execution");
    const originalStart = stepExecution.startStepRun;
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const spy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockImplementation(async (...args) => {
        admissionEntered();
        await admissionHeld;
        return originalStart(...args);
      });

    const started = startSingleRun(testAccountScope(), recipeId, target.id);
    let cancelled: Promise<CascadeRun> | undefined;
    try {
      await entered;
      const pending = listCascades(recipeId)[0];
      expect(memberOf(pending, target.id)).toMatchObject({
        state: "pending",
        jobId: null,
        attempt: null,
      });

      cancelled = cancelCascade(testAccountScope(), pending.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(readCascade(pending.id).cancelled).toBe(true);

      releaseAdmission();
      const [startAnswer, cancelAnswer] = await Promise.all([started, cancelled]);
      const newerId = memberOf(startAnswer, target.id).jobId!;
      expect(newerId).not.toBe(older.id);
      expect(cancelAnswer.outcome).toBe("cancelled");
      expect(getJob(newerId)).toBeNull();
      expect(listJobs({ subjectId: target.id }).map((job) => job.id)).toEqual([older.id]);

      const attempt = memberOf(readCascade(pending.id), target.id).attempt;
      expect(attempt?.state).toBe("cancelled");
    } finally {
      releaseAdmission();
      await Promise.allSettled([started, ...(cancelled ? [cancelled] : [])]);
      spy.mockRestore();
      delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT;
    }
  }, 120_000);

  it("keeps a depth-1 attempt when the driver finds the fence after admission", async () => {
    process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT = "1";
    const target = step("SELECT 1 AS n", "depth_one_driver_fence");
    const older = await startStepRun(testAccountScope(), target.id);
    await laneSettled();
    expect(getJob(older.id)?.state).toBe("succeeded");
    expect(
      editStep(target.id, { sql: ENDLESS, name: "depth_one_driver_fence" }),
    ).toBe("proposed");

    const stepExecution = await import("./step-execution");
    const originalStart = stepExecution.startStepRun;
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const spy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockImplementation(async (...args) => {
        admissionEntered();
        await admissionHeld;
        return originalStart(...args);
      });

    let cancelled: Promise<CascadeRun> | undefined;
    try {
      const cascade = await startCascade(testAccountScope(), { recipeId });
      await entered;
      expect(memberOf(readCascade(cascade.id), target.id)).toMatchObject({
        state: "pending",
        jobId: null,
        attempt: null,
      });

      cancelled = cancelCascade(testAccountScope(), cascade.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(readCascade(cascade.id).cancelled).toBe(true);

      releaseAdmission();
      const answer = await cancelled;
      const newerId = memberOf(answer, target.id).jobId!;
      expect(newerId).not.toBe(older.id);
      expect(answer.outcome).toBe("cancelled");
      expect(getJob(newerId)).toBeNull();
      expect(listJobs({ subjectId: target.id }).map((job) => job.id)).toEqual([older.id]);

      const attempt = memberOf(readCascade(cascade.id), target.id).attempt;
      expect(attempt?.state).toBe("cancelled");
    } finally {
      releaseAdmission();
      if (cancelled) await Promise.allSettled([cancelled]);
      spy.mockRestore();
      delete process.env.DEZFIL_OPERATION_HISTORY_PER_SUBJECT;
    }
  }, 120_000);
});

describe("a run reads whole on its own", () => {
  it("keeps each attempted member's attempt with the run, and names a removed node", async () => {
    const one = step("SELECT name FROM stations", "whole_one");
    const two = step("SELECT name FROM nowhere_at_all", "whole_two");
    const three = step("SELECT name FROM whole_two", "whole_three");
    const run = await runAll();
    expect(run.outcome).toBe("partly_completed");
    const first = memberOf(run, one.id);
    expect(first.operation).toBe("sql_step");
    expect(first.name).toBe("whole_one");
    expect(first.attempt?.state).toBe("succeeded");
    expect(first.attempt?.acceptedAt).toBeTruthy();
    expect(first.attempt?.finishedAt).toBeTruthy();
    expect(first.attempt?.output?.name).toBe("whole_one");
    // The failed member's attempt says why, in the engine's words.
    const failed = memberOf(run, two.id);
    expect(failed.state).toBe("failed");
    expect(failed.attempt?.state).toBe("failed");
    expect(failed.attempt?.error?.message).toMatch(/nowhere_at_all/);
    // A member never attempted has no attempt.
    const blocked = memberOf(run, three.id);
    expect(blocked.state).toBe("not_run");
    expect(blocked.jobId).toBeNull();
    expect(blocked.attempt).toBeNull();
    // The attempts survive the jobs themselves: pruned, deleted, gone.
    metadataDb().prepare(`DELETE FROM operation_jobs WHERE id IN (?, ?)`).run(first.jobId, failed.jobId);
    expect(getJob(first.jobId!)).toBeNull();
    const after = readCascade(run.id);
    expect(memberOf(after, one.id).attempt?.state).toBe("succeeded");
    expect(memberOf(after, one.id).attempt?.output?.name).toBe("whole_one");
    expect(memberOf(after, two.id).attempt?.error?.message).toMatch(/nowhere_at_all/);
    // The node removed, the run still names it.
    removeStep(two.id);
    expect(memberOf(readCascade(run.id), two.id).name).toBe("whole_two");
    expect(memberOf(readCascade(run.id), two.id).operation).toBe("sql_step");
  }, 120_000);

  it("reads a live member's attempt from its job: queued or running, which the member's own state cannot say", async () => {
    const slow = step(ENDLESS, "live_slow");
    const cascade = await startCascade(testAccountScope(), { recipeId, fromStepId: slow.id });
    const deadline = Date.now() + 20_000;
    let seen: string | undefined;
    while (Date.now() < deadline) {
      const m = memberOf(readCascade(cascade.id), slow.id);
      if (m.state === "running" && m.attempt) {
        seen = m.attempt.state;
        if (seen === "running") break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toBe("running");
    await cancelCascade(testAccountScope(), cascade.id);
    const done = readCascade(cascade.id);
    expect(done.outcome).toBe("cancelled");
    // The interrupted member: a failed member whose attempt was cancelled.
    expect(memberOf(done, slow.id).state).toBe("failed");
    expect(memberOf(done, slow.id).attempt?.state).toBe("cancelled");
  }, 60_000);
});

describe("a node's own run is one of the workflow's runs", () => {
  it("waits for a held admission before answering cancellation", async () => {
    const held = step("SELECT name FROM stations", "single_held");
    const stepExecution = await import("./step-execution");
    const originalStart = stepExecution.startStepRun;
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const spy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockImplementation(async (...args) => {
        admissionEntered();
        await admissionHeld;
        return originalStart(...args);
      });

    const started = startSingleRun(testAccountScope(), recipeId, held.id);
    let cancelled: Promise<CascadeRun> | undefined;
    try {
      await entered;
      const listed = listCascades(recipeId);
      expect(listed).toHaveLength(1);
      const pending = listed[0];
      expect(pending.outcome).toBeNull();
      expect(memberOf(pending, held.id)).toMatchObject({
        state: "pending",
        jobId: null,
        attempt: null,
      });

      let earlyAnswer: CascadeRun | undefined;
      cancelled = cancelCascade(testAccountScope(), pending.id);
      void cancelled.then((answer) => {
        earlyAnswer = answer;
      });
      // The fence is the positive control that cancellation reached this exact
      // pending run. Two microtask turns are enough for the shipped no-drive
      // wait to answer; a registered lifecycle remains held on admission.
      await Promise.resolve();
      await Promise.resolve();
      const fenced = readCascade(pending.id);
      expect(fenced.cancelled).toBe(true);
      expect(memberOf(fenced, held.id)).toMatchObject({ state: "pending", jobId: null });

      const earlyOutcome = earlyAnswer ? earlyAnswer.outcome : "not_answered";
      expect(earlyOutcome).not.toBeNull();

      releaseAdmission();
      const [startAnswer, cancelAnswer] = await Promise.all([started, cancelled]);
      expect(startAnswer.outcome).toBe("cancelled");
      expect(cancelAnswer.outcome).toBe("cancelled");
      expect(readCascade(pending.id)).toEqual({ ...cancelAnswer, outputs: [] });
      expect(memberOf(cancelAnswer, held.id).attempt?.state).toBe("cancelled");
    } finally {
      releaseAdmission();
      await Promise.allSettled([started, ...(cancelled ? [cancelled] : [])]);
      spy.mockRestore();
    }
  }, 60_000);

  it("retains a cancelled run when its held admission later refuses", async () => {
    const held = step("SELECT name FROM stations", "single_refused_after_cancel");
    const stepExecution = await import("./step-execution");
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const spy = vi
      .spyOn(stepExecution, "startStepRun")
      .mockImplementation(async () => {
        admissionEntered();
        await admissionHeld;
        throw new ApiError("name_taken", "The held admission was refused.", 409);
      });

    const started = startSingleRun(testAccountScope(), recipeId, held.id);
    const refused = expect(started).rejects.toMatchObject({ code: "name_taken" });
    let cancelled: Promise<CascadeRun> | undefined;
    try {
      await entered;
      const pending = listCascades(recipeId)[0];
      expect(memberOf(pending, held.id)).toMatchObject({ state: "pending", jobId: null });

      cancelled = cancelCascade(testAccountScope(), pending.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(readCascade(pending.id).cancelled).toBe(true);

      releaseAdmission();
      await refused;
      const answer = await cancelled;
      expect(answer.outcome).toBe("cancelled");
      expect(answer.members).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ state: "pending" })]),
      );
      expect(memberOf(answer, held.id)).toMatchObject({
        state: "failed",
        jobId: null,
        stoppedBy: "name_taken",
        stoppedReason: "The held admission was refused.",
        attempt: null,
      });
      expect(readCascade(pending.id)).toEqual({ ...answer, outputs: [] });
      expect(listCascades(recipeId)).toHaveLength(1);
    } finally {
      releaseAdmission();
      await Promise.allSettled([started, ...(cancelled ? [cancelled] : [])]);
      spy.mockRestore();
    }
  }, 60_000);

  it("runs one member as a single run, under the lock, cancellable as a run", async () => {
    const slow = step(ENDLESS, "single_slow");
    const other = step("SELECT name FROM stations", "single_other");
    const run = await startSingleRun(testAccountScope(), recipeId, slow.id);
    expect(run.kind).toBe("single");
    expect(run.members.map((m) => m.stepId)).toEqual([slow.id]);
    // One run at a time: a cascade and another single run are refused, naming it.
    await expect(startCascade(testAccountScope(), { recipeId })).rejects.toMatchObject({ code: "run_in_flight" });
    await expect(startSingleRun(testAccountScope(), recipeId, other.id)).rejects.toMatchObject({ code: "run_in_flight" });
    expect(listCascades(recipeId)).toHaveLength(1);
    const cancelled = await cancelCascade(testAccountScope(), run.id);
    expect(cancelled.outcome).toBe("cancelled");
    expect(memberOf(cancelled, slow.id).attempt?.state).toBe("cancelled");
    // Settled, the other runs.
    const next = await startSingleRun(testAccountScope(), recipeId, other.id);
    await cascadeSettled(next.id);
    expect(readCascade(next.id).outcome).toBe("completed");
  }, 60_000);

  it("mints neither a run nor an attempt when the node cannot be admitted alone", async () => {
    // A dataset name a table already carries is refused at admission, before
    // any job exists (a SQL text naming a missing table is not: that fails
    // as an attempt, and the attempt says so).
    const taken = step("SELECT name FROM stations", "stations");
    await expect(startSingleRun(testAccountScope(), recipeId, taken.id)).rejects.toMatchObject({ code: "name_taken" });
    expect(listCascades(recipeId)).toEqual([]);
    expect(listJobs({ subjectId: taken.id })).toEqual([]);
  }, 30_000);
});

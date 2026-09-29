import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { boundedEvaluation } from "@/lib/query/bounded";
import { limits } from "@/lib/limits";
import { getJob } from "@/lib/metadata/jobs";
import { startRun } from "./run";
import { laneSettled, resetLane, submit } from "./lane";

/**
 * The lane budget's two criteria, executably (16 and 17).
 *
 * Reading two defaults and observing that one is larger proves nothing about
 * the override path, and comparing a default to a constant the implementation
 * also supplies compares the implementation to itself. Both are done properly
 * here: the override is exercised against a real engine, and the margin is
 * checked against a committed measurement record produced by a separate script.
 */

let dir: string;

beforeEach(async () => {
  resetLane();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb();
  resetQueryInstance();
  const src = path.join(dir, "stations.csv");
  await writeFile(src, "name,lon,lat\nalexanderplatz,13.41,52.52\nzoo,13.33,52.51\n");
  await ingestFile(testAccountScope(), src, "stations.csv");
  await boundedEvaluation(async () => undefined, { scope: testAccountScope() });
});

afterEach(async () => {
  vi.useRealTimers();
  resetLane();
  closeMetadataDb();
  resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  delete process.env.DEZFIL_QUERY_TIMEOUT_S;
  delete process.env.DEZFIL_OPERATION_TIMEOUT_S;
  await rm(dir, { recursive: true, force: true });
});

describe("the lane budget replaces the query budget", () => {
  // ~4 s of real engine work: comfortably past a 1 s query bound, comfortably
  // inside a 120 s lane bound. The gap between the two is the whole point.
  const SLOW =
    "SELECT count(*) AS n FROM range(40000) a, range(40000) b WHERE (a.range * b.range) % 7 = 3";

  it("an operation past the user-query bound still succeeds inside the lane bound", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "1";
    process.env.DEZFIL_OPERATION_TIMEOUT_S = "120";

    const job = await startRun(testAccountScope(), {
      operation: "sql_step",
      parameters: { sql: SLOW, name: "past_the_query_bound" },
    });
    await laneSettled();

    const settled = getJob(job.id)!;
    // If the run inherited the one-second query timeout instead of the lane's
    // own, this is a query_timeout failure rather than a success — which is
    // exactly the regression the criterion exists to catch.
    expect(settled.errorCode).toBeNull();
    expect(settled.state).toBe("succeeded");
    expect(settled.outputName).toBe("past_the_query_bound");
  }, 180_000);

  it("and the lane's own bound still bites, with its own coded error", async () => {
    process.env.DEZFIL_QUERY_TIMEOUT_S = "600";
    process.env.DEZFIL_OPERATION_TIMEOUT_S = "1";

    const job = await startRun(testAccountScope(), {
      operation: "sql_step",
      parameters: { sql: SLOW, name: "past_the_lane_bound" },
    });
    await laneSettled();

    const settled = getJob(job.id)!;
    expect(settled.state).toBe("failed");
    // The lane's code, not the query path's — and it names the setting that
    // raises it, so the message is actionable rather than merely coded.
    expect(settled.errorCode).toBe("operation_timeout");
    expect(settled.errorMessage).toContain("DEZFIL_OPERATION_TIMEOUT_S");
  }, 180_000);
});

describe("queue wait is not charged against the run budget", () => {
  it("a job held queued past the whole budget still succeeds when it runs", async () => {
    // A controlled lane gate owns the one slot while Date advances exactly
    // past the three-second budget. Unlike the old timed blocker, admission
    // cannot consume a few milliseconds of the interval this assertion needs.
    process.env.DEZFIL_OPERATION_CONCURRENCY = "1";
    process.env.DEZFIL_OPERATION_TIMEOUT_S = "3";
    vi.useFakeTimers({ toFake: ["Date"] });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    submit("budget-test-blocker", async () => blocked);
    try {
      const waited = await startRun(testAccountScope(), {
        operation: "sql_step",
        // Deliberately longer than a one-millisecond expired budget but well
        // inside three seconds. If the deadline starts at admission, the
        // clock jump makes this take the one-millisecond floor and fail.
        parameters: {
          sql: "SELECT count(*) AS n FROM range(10000) a, range(10000) b WHERE (a.range * b.range) % 7 = 3",
          name: "waited_its_turn",
        },
      });

      const acceptedAt = new Date(waited.acceptedAt).getTime();
      vi.setSystemTime(acceptedAt + limits.operationTimeoutMs + 1);
      unblock();
      await laneSettled();

      // The job behind the gate succeeds. If the budget's clock started at
      // admission rather than at execution, this one would already have been
      // out of time before it began, and would fail here instead.
      const settled = getJob(waited.id)!;
      expect(settled.state).toBe("succeeded");
      expect(settled.outputName).toBe("waited_its_turn");
      // Proof the wait really did exceed the budget.
      const queuedForMs =
        new Date(settled.startedAt!).getTime() -
        new Date(settled.acceptedAt).getTime();
      expect(queuedForMs).toBe(limits.operationTimeoutMs + 1);
    } finally {
      unblock();
      delete process.env.DEZFIL_OPERATION_CONCURRENCY;
    }
  }, 180_000);
});

/** The margin the gate approved, pinned in the test rather than read from the
 * measurement record the test constrains. */
const APPROVED_MARGIN = 10;

describe("the shipped default admits the measured work", () => {
  it("clears a tenfold margin over the committed E9 measurement", async () => {
    // The measurement comes from a file a separate script wrote, not from a
    // constant this code also supplies. That independence is what lets this
    // check fail: lowering the default, or a slower measurement, breaks it.
    const record = JSON.parse(
      await readFile(
        path.join(process.cwd(), "scripts", "perf", "overlay-budget.json"),
        "utf8",
      ),
    ) as { slowestVerifiedOverlayMs: number; rows: number };

    expect(record.rows).toBeGreaterThanOrEqual(1_000_000);
    expect(record.slowestVerifiedOverlayMs).toBeGreaterThan(0);

    // The factor is pinned HERE, not read from the record. Taking it from the
    // same generated file would let a regenerated record redefine the
    // requirement it is supposed to be held to — regenerate with a multiplier
    // of two, drop the default to 60 s, and the check would still pass.
    const required = record.slowestVerifiedOverlayMs * APPROVED_MARGIN;
    expect(limits.operationTimeoutMs).toBeGreaterThanOrEqual(required);
  });

  it("rejects a 60-second default, which merely exceeds the measurement", async () => {
    // The margin is the criterion's substance, so this names the concrete
    // default that must not pass: 60 s clears the ~24 s measurement outright
    // and is still far short of the required margin.
    const record = JSON.parse(
      await readFile(
        path.join(process.cwd(), "scripts", "perf", "overlay-budget.json"),
        "utf8",
      ),
    ) as { slowestVerifiedOverlayMs: number };

    const sixtySeconds = 60_000;
    expect(sixtySeconds).toBeGreaterThan(record.slowestVerifiedOverlayMs);
    expect(sixtySeconds).toBeLessThan(
      record.slowestVerifiedOverlayMs * APPROVED_MARGIN,
    );
  });
});

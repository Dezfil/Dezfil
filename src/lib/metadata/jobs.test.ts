import { testAccountScope } from "@/lib/test-support/accounts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { open } from "./db";
import {
  insertJob,
  getJob,
  listJobs,
  markRunning,
  finish,
  nonTerminalJobs,
  pruneSubject,
  isTerminal,
  type OperationJob,
} from "./jobs";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  db = open(path.join(dir, "metadata.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
function sample(overrides: Partial<OperationJob> = {}): OperationJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    subjectKind: "run",
    subjectId: `job-${seq}`,
    operation: "sql_step",
    parameters: { sql: "SELECT 1", name: "out" },
    state: "queued",
    errorCode: null,
    errorMessage: null,
    outputId: null,
    outputName: null,
    // Distinct, increasing timestamps: ordering is part of the contract.
    acceptedAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("the job record", () => {
  it("round-trips a job, parameters included", () => {
    const job = sample();
    insertJob(testAccountScope(db), job, db);
    expect(getJob(job.id, db)).toEqual(job);
  });

  it("answers null for an unknown id", () => {
    expect(getJob("nope", db)).toBeNull();
  });

  it("lists newest first", () => {
    const a = sample();
    const b = sample();
    const c = sample();
    for (const j of [a, b, c]) insertJob(testAccountScope(db), j, db);
    expect(listJobs({}, db).map((j) => j.id)).toEqual([c.id, b.id, a.id]);
  });

  it("filters to one subject", () => {
    insertJob(testAccountScope(db), sample({ subjectId: "s1", subjectKind: "client" }), db);
    insertJob(testAccountScope(db), sample({ subjectId: "s2", subjectKind: "client" }), db);
    insertJob(testAccountScope(db), sample({ subjectId: "s1", subjectKind: "client" }), db);
    const mine = listJobs({ subjectId: "s1" }, db);
    expect(mine).toHaveLength(2);
    expect(mine.every((j) => j.subjectId === "s1")).toBe(true);
  });

  it("a queued job has no start time until it starts", () => {
    const job = sample();
    insertJob(testAccountScope(db), job, db);
    expect(getJob(job.id, db)!.startedAt).toBeNull();
    expect(markRunning(job.id, "2026-08-12T00:00:01.000Z", db)).toBe(true);
    expect(getJob(job.id, db)!.startedAt).toBe("2026-08-12T00:00:01.000Z");
  });
});

describe("terminal writes are conditional — the authority check", () => {
  it("settles a running job", () => {
    const job = sample();
    insertJob(testAccountScope(db), job, db);
    markRunning(job.id, "t1", db);
    expect(
      finish(job.id, { state: "succeeded", output: { id: "t", name: "out" } }, "t2", db),
    ).toBe(true);
    const done = getJob(job.id, db)!;
    expect(done.state).toBe("succeeded");
    expect(done.outputName).toBe("out");
  });

  it("refuses a second terminal write, so a cancel cannot be overwritten", () => {
    const job = sample();
    insertJob(testAccountScope(db), job, db);
    markRunning(job.id, "t1", db);
    expect(finish(job.id, { state: "cancelled" }, "t2", db)).toBe(true);
    // The run finished its work a moment later and tried to publish. This
    // false is exactly what stops it registering an output.
    expect(
      finish(job.id, { state: "succeeded", output: { id: "t", name: "out" } }, "t3", db),
    ).toBe(false);
    const after = getJob(job.id, db)!;
    expect(after.state).toBe("cancelled");
    expect(after.outputName).toBeNull();
  });

  it("refuses to start a job that was cancelled while queued", () => {
    const job = sample();
    insertJob(testAccountScope(db), job, db);
    expect(finish(job.id, { state: "cancelled" }, "t1", db)).toBe(true);
    expect(markRunning(job.id, "t2", db)).toBe(false);
    expect(getJob(job.id, db)!.startedAt).toBeNull();
  });

  it("reports every non-terminal job, queued and running alike", () => {
    const queued = sample();
    const running = sample();
    const done = sample();
    for (const j of [queued, running, done]) insertJob(testAccountScope(db), j, db);
    markRunning(running.id, "t1", db);
    finish(done.id, { state: "succeeded" }, "t2", db);

    const stuck = nonTerminalJobs(db);
    expect(stuck.map((j) => j.id).sort()).toEqual([queued.id, running.id].sort());
    expect(stuck.map((j) => j.state).sort()).toEqual(["queued", "running"]);
  });

  it("agrees with isTerminal about which states are final", () => {
    expect(["succeeded", "failed", "cancelled"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["queued", "running"].some((s) => isTerminal(s as never))).toBe(false);
  });
});

describe("retention", () => {
  /** Drive `count` terminal runs for one subject, oldest first. */
  function drive(subject: string, count: number, state: "failed" | "succeeded") {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const job = sample({ subjectId: subject, subjectKind: "client" });
      insertJob(testAccountScope(db), job, db);
      finish(job.id, { state, errorCode: state === "failed" ? "sql_error" : null }, "t", db);
      ids.push(job.id);
    }
    return ids;
  }

  it("holds the cap", () => {
    drive("s", 10, "failed");
    pruneSubject("s", 4, db);
    expect(listJobs({ subjectId: "s" }, db)).toHaveLength(4);
  });

  it("keeps the most recent success even when the cap would drop it", () => {
    // The success is oldest, then enough failures to push it out of a cap of 3.
    const [success] = drive("s", 1, "succeeded");
    drive("s", 6, "failed");

    pruneSubject("s", 3, db);

    const kept = listJobs({ subjectId: "s" }, db);
    expect(kept).toHaveLength(3);
    expect(kept.map((j) => j.id)).toContain(success);
    // Inside the cap, not beside it — the depth means one number.
    expect(kept.filter((j) => j.state === "succeeded")).toHaveLength(1);
  });

  it("never prunes a queued or running job", () => {
    drive("s", 8, "failed");
    const queued = sample({ subjectId: "s", subjectKind: "client" });
    const running = sample({ subjectId: "s", subjectKind: "client" });
    insertJob(testAccountScope(db), queued, db);
    insertJob(testAccountScope(db), running, db);
    markRunning(running.id, "t1", db);

    pruneSubject("s", 2, db);

    const survivors = listJobs({ subjectId: "s" }, db).map((j) => j.id);
    expect(survivors).toContain(queued.id);
    expect(survivors).toContain(running.id);
  });

  it("leaves other subjects alone", () => {
    drive("mine", 6, "failed");
    drive("theirs", 6, "failed");
    pruneSubject("mine", 2, db);
    expect(listJobs({ subjectId: "mine" }, db)).toHaveLength(2);
    expect(listJobs({ subjectId: "theirs" }, db)).toHaveLength(6);
  });

  it("is a no-op below the cap", () => {
    drive("s", 3, "failed");
    expect(pruneSubject("s", 10, db)).toBe(0);
    expect(listJobs({ subjectId: "s" }, db)).toHaveLength(3);
  });
});

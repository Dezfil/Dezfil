import { describe, it, expect } from "vitest";
import { composeLog, forNode } from "./messages";
import type { RunMember, WorkflowRun } from "./run-overlay";

const member = (o: Partial<RunMember> & { stepId: string; state: RunMember["state"] }): RunMember => ({
  ordinal: 0, operation: "sql_step", name: `${o.stepId}_out`, jobId: null, stoppedBy: null, stoppedReason: null, output: null, attempt: null, ...o,
});
const attempt = (state: "queued" | "running" | "succeeded" | "failed" | "cancelled", o: Partial<NonNullable<RunMember["attempt"]>> = {}) => ({
  state, error: null, acceptedAt: "2026-08-25T10:00:00Z", startedAt: "2026-08-25T10:00:01Z", finishedAt: "2026-08-25T10:00:05Z", output: null, ...o,
});

describe("the Messages log", () => {
  it("composes one entry per event of a diamond run, newest first, in the fixed order at one time", () => {
    const run: WorkflowRun = {
      id: "r1", recipeId: "w", kind: "run_all", outcome: "partly_completed", cancelled: false,
      startedAt: "2026-08-25T10:00:00Z", finishedAt: "2026-08-25T10:00:09Z",
      members: [
        member({ stepId: "a", ordinal: 0, state: "succeeded", output: { id: "t", name: "a_out" }, attempt: attempt("succeeded", { output: { id: "t", name: "a_out" } }) }),
        member({ stepId: "b", ordinal: 1, state: "failed", attempt: attempt("failed", { error: { code: "sql_error", message: "Table nowhere does not exist." }, finishedAt: "2026-08-25T10:00:09Z" }) }),
        member({ stepId: "c", ordinal: 2, state: "not_run", stoppedBy: "b" }),
        member({ stepId: "d", ordinal: 3, state: "succeeded", output: { id: "t2", name: "d_out" }, attempt: attempt("succeeded", { startedAt: "2026-08-25T10:00:06Z", finishedAt: "2026-08-25T10:00:08Z" }) }),
      ],
    };
    const log = composeLog([run]);
    expect(log.map((e) => `${e.level}:${e.text}`)).toEqual([
      // 10:00:09 — the run's outcome first, then b's outcome, then c's (the run's finishing time).
      "warn:Partly completed · 2 of 4 succeeded",
      "error:b_out failed. Table nowhere does not exist.",
      "warn:c_out not run. b_out did not succeed.",
      "ok:d_out wrote d_out",
      "info:d_out started",
      "ok:a_out wrote a_out",
      "info:a_out started",
      "info:b_out started",
      "info:Run all · 4 nodes",
    ]);
    // c's entry carries the run's finishing time, having no attempt.
    expect(log.find((e) => e.stepId === "c")?.time).toBe("2026-08-25T10:00:09Z");
    expect(forNode(log, "b").map((e) => e.text)).toEqual(["b_out failed. Table nowhere does not exist.", "b_out started"]);
  });

  it("says a single run, a cancelled member, an interrupted outcome, and names a removed node by its kept identity", () => {
    const run: WorkflowRun = {
      id: "r2", recipeId: "w", kind: "single", outcome: "cancelled", cancelled: true,
      startedAt: "2026-08-25T11:00:00Z", finishedAt: "2026-08-25T11:00:03Z",
      members: [member({ stepId: "gone", name: "gone_out", state: "failed", stoppedBy: "cancelled", attempt: attempt("cancelled", { acceptedAt: "2026-08-25T11:00:00Z", startedAt: "2026-08-25T11:00:01Z", finishedAt: "2026-08-25T11:00:03Z" }) })],
    };
    const log = composeLog([run]);
    expect(log.map((e) => e.text)).toEqual(["Cancelled · 0 of 1 succeeded", "gone_out cancelled.", "gone_out started", "Run gone_out"]);
    expect(log.every((e) => e.stepId === null || e.node === "gone_out")).toBe(true);
    const interrupted = composeLog([{ ...run, id: "r3", outcome: "interrupted", members: [member({ stepId: "x", state: "not_run", stoppedBy: "operation_interrupted" })] }]);
    expect(interrupted.map((e) => e.text)).toEqual(["Interrupted", "x_out not run. The server stopped before its turn.", "Run x_out"]);
  });

  it("orders runs newest first across runs and leaves a run in flight without an outcome entry", () => {
    const older: WorkflowRun = { id: "o", recipeId: "w", kind: "run_all", outcome: "completed", cancelled: false, startedAt: "2026-08-25T09:00:00Z", finishedAt: "2026-08-25T09:00:05Z", members: [member({ stepId: "a", state: "succeeded", attempt: attempt("succeeded", { startedAt: "2026-08-25T09:00:01Z", finishedAt: "2026-08-25T09:00:04Z" }) })] };
    const live: WorkflowRun = { id: "l", recipeId: "w", kind: "run_all", outcome: null, cancelled: false, startedAt: "2026-08-25T12:00:00Z", finishedAt: null, members: [member({ stepId: "a", state: "running", attempt: attempt("running", { acceptedAt: "2026-08-25T12:00:00Z", startedAt: "2026-08-25T12:00:01Z", finishedAt: null }) })] };
    const log = composeLog([live, older]);
    expect(log[0].text).toBe("a_out started");
    expect(log[1].text).toBe("Run all · 1 node");
    expect(log.some((e) => e.runId === "l" && e.id.endsWith(":outcome"))).toBe(false);
    expect(log[log.length - 1].text).toBe("Run all · 1 node");
    expect(log[log.length - 1].runId).toBe("o");
  });
});

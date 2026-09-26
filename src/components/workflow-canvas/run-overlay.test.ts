import { describe, it, expect } from "vitest";
import { memberWord, mergeRun, outcomeLine, overlayFor, settledCount, type RunAttempt, type RunMember, type WorkflowRun } from "./run-overlay";

const member = (o: Partial<RunMember> & { stepId: string; state: RunMember["state"] }): RunMember => ({
  ordinal: 0, operation: "sql_step", name: `${o.stepId}_out`, jobId: null, stoppedBy: null, stoppedReason: null, output: null, attempt: null, ...o,
});
const attempt = (state: RunAttempt["state"], error: { code: string; message: string } | null = null): RunAttempt => ({
  state, error, acceptedAt: "2026-08-25T00:00:00Z", startedAt: null, finishedAt: null, output: null,
});
const run = (members: RunMember[], outcome: WorkflowRun["outcome"] = null): WorkflowRun => ({
  id: "r1", recipeId: "w", kind: "run_all", outcome, cancelled: outcome === "cancelled", startedAt: "2026-08-25T00:00:00Z", finishedAt: null, members,
});

describe("the run's word for a member", () => {
  it("says waiting, queued, running and the settled words from the record and the attempt", () => {
    expect(memberWord(member({ stepId: "a", state: "pending" })).word).toBe("waiting");
    expect(memberWord(member({ stepId: "a", state: "running", attempt: attempt("queued") })).word).toBe("queued");
    expect(memberWord(member({ stepId: "a", state: "running", attempt: attempt("running") })).word).toBe("running");
    expect(memberWord(member({ stepId: "a", state: "succeeded" })).word).toBe("up to date");
    const failed = memberWord(member({ stepId: "a", state: "failed", attempt: attempt("failed", { code: "sql_error", message: "Table nowhere does not exist." }) }));
    expect(failed).toEqual({ word: "run failed", tone: "bad", reason: "Table nowhere does not exist." });
    // Refused at admission: no attempt, the member's own sentence.
    expect(memberWord(member({ stepId: "a", state: "failed", stoppedBy: "name_taken", stoppedReason: "A table named x already exists." })).reason).toBe("A table named x already exists.");
    // Interrupted while running: a failed member whose attempt was cancelled.
    expect(memberWord(member({ stepId: "a", state: "failed", stoppedBy: "cancelled", attempt: attempt("cancelled") })).word).toBe("cancelled");
    expect(memberWord(member({ stepId: "b", state: "not_run", stoppedBy: "a" })).reason).toBe("Not run: a node it depends on did not succeed.");
    // With the run at hand, the blocker is named.
    const r = run([member({ stepId: "a", state: "failed" }), member({ stepId: "b", state: "not_run", stoppedBy: "a" })]);
    expect(memberWord(r.members[1], r).reason).toBe("Not run: a_out did not succeed.");
    expect(overlayFor(r)?.members.b.reason).toBe("Not run: a_out did not succeed.");
    expect(memberWord(member({ stepId: "b", state: "not_run", stoppedBy: "cancelled" })).reason).toMatch(/cancelled before its turn/);
  });

  it("composes the overlay, the outcome line and the settled count from the record", () => {
    const r = run([
      member({ stepId: "a", state: "succeeded" }),
      member({ stepId: "b", state: "failed", attempt: attempt("failed", { code: "x", message: "Boom." }) }),
      member({ stepId: "c", state: "not_run", stoppedBy: "b" }),
    ], "partly_completed");
    expect(overlayFor(r)?.members.c.word).toBe("not run");
    expect(overlayFor(null)).toBeNull();
    expect(outcomeLine(r)).toBe("Partly completed · 1 of 3 succeeded");
    expect(outcomeLine({ ...r, outcome: "completed", members: r.members.map((m) => ({ ...m, state: "succeeded" as const })) })).toBe("Completed · 3 nodes");
    expect(outcomeLine({ ...r, outcome: "cancelled" })).toBe("Cancelled · 1 of 3 succeeded");
    expect(outcomeLine({ ...r, outcome: "interrupted" })).toBe("Interrupted · 1 of 3 succeeded");
    expect(settledCount(run([member({ stepId: "a", state: "succeeded" }), member({ stepId: "b", state: "running" }), member({ stepId: "c", state: "pending" })]))).toBe(1);
  });

  it("merges a run's answer into the live list, newest first when new", () => {
    const older = run([member({ stepId: "a", state: "succeeded" })], "completed");
    const older2 = { ...older, id: "r0" };
    expect(mergeRun([older2], older).map((r) => r.id)).toEqual(["r1", "r0"]);
    const updated = { ...older, outcome: "failed" as const };
    expect(mergeRun([older, older2], updated)[0].outcome).toBe("failed");
    // The live list keeps to the API's newest hundred.
    const hundred = Array.from({ length: 100 }, (_, i) => ({ ...older, id: `h${i}` }));
    expect(mergeRun(hundred, { ...older, id: "new" })).toHaveLength(100);
  });
});

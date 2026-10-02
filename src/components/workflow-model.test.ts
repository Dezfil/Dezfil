import { describe, it, expect } from "vitest";
import type { RecipeSummary } from "@/lib/operations/recipe-summary";
import { chipFor, matchesQuery, nodeState, passesFilter, sortWorkflows, type WorkflowListing, type WorkflowStep } from "./workflow-model";

const sum = (status: RecipeSummary["status"], count = 0): RecipeSummary => ({
  nodes: 3, sources: 1, liveOutputs: 0, status, count,
});
const wf = (name: string, status: RecipeSummary["status"], count = 0, when = "2026-08-25T00:00:00.000Z"): WorkflowListing => ({
  id: name, name, origin: "workflow", projectId: null, createdAt: when, updatedAt: when, lastChangedAt: when, summary: sum(status, count), steps: [],
});

describe("the chip a card wears", () => {
  it("words each status the way the spec does", () => {
    expect(chipFor(sum("empty"))).toEqual({ label: "Empty", tone: "muted" });
    expect(chipFor(sum("cannot_run", 2))).toEqual({ label: "2 cannot run", tone: "bad" });
    expect(chipFor(sum("in_progress", 1))).toEqual({ label: "1 in progress", tone: "accent" });
    expect(chipFor(sum("failed", 1))).toEqual({ label: "1 failed", tone: "bad" });
    expect(chipFor(sum("run_again", 3))).toEqual({ label: "3 to run again", tone: "warn" });
    expect(chipFor(sum("never_run", 3))).toEqual({ label: "Never run", tone: "muted" });
    expect(chipFor(sum("partly_never_run", 1))).toEqual({ label: "1 never run", tone: "muted" });
    expect(chipFor(sum("up_to_date"))).toEqual({ label: "Up to date", tone: "ok" });
  });
});

describe("the filters", () => {
  const cannot = wf("a", "cannot_run", 1), failed = wf("b", "failed", 1), again = wf("c", "run_again", 2);
  const never = wf("d", "never_run", 3), partly = wf("e", "partly_never_run", 1), fine = wf("f", "up_to_date"), empty = wf("g", "empty");
  const all = [cannot, failed, again, never, partly, fine, empty];
  it("Needs attention keeps cannot-run, failed and to-run-again, nothing else", () => {
    expect(all.filter((w) => passesFilter(w, "attention")).map((w) => w.id)).toEqual(["a", "b", "c"]);
  });
  it("Never run keeps only workflows with nodes and no output at all", () => {
    expect(all.filter((w) => passesFilter(w, "never")).map((w) => w.id)).toEqual(["d"]);
  });
  it("All keeps everything, and search matches the name", () => {
    expect(all.filter((w) => passesFilter(w, "all")).length).toBe(7);
    expect(all.filter((w) => matchesQuery(w, "  A ")).map((w) => w.id)).toEqual(["a"]);
    expect(all.filter((w) => matchesQuery(w, "")).length).toBe(7);
  });
});

describe("the sorts", () => {
  it("sort by last edited, by created, and by name", () => {
    const a = { ...wf("b", "up_to_date"), createdAt: "2026-08-01T00:00:00.000Z", lastChangedAt: "2026-08-25T10:00:00.000Z" };
    const b = { ...wf("a", "up_to_date"), createdAt: "2026-08-02T00:00:00.000Z", lastChangedAt: "2026-08-25T09:00:00.000Z" };
    expect(sortWorkflows([b, a], "edited").map((w) => w.name)).toEqual(["b", "a"]);
    expect(sortWorkflows([a, b], "created").map((w) => w.name)).toEqual(["a", "b"]);
    expect(sortWorkflows([a, b], "name").map((w) => w.name)).toEqual(["a", "b"]);
  });
});

describe("a node's state word on the workflow page", () => {
  const node = (o: Partial<WorkflowStep>): WorkflowStep => ({
    id: "n", ordinal: 0, operation: "buffer", parameters: {}, proposedParameters: null, output: null, reads: [],
    condition: "current", conditions: ["current"], causes: [], missingInputs: [], inputs: [], latestAttempt: null,
    lastSuccessAt: null, ...o,
  });
  it("says the un-runnable before the un-current, and a run in flight first", () => {
    expect(nodeState(node({ latestAttempt: { state: "running" } })).label).toBe("running");
    expect(nodeState(node({ conditions: ["broken", "stale"], latestAttempt: { state: "failed" } })).label).toBe("cannot run");
    expect(nodeState(node({ conditions: ["stale"], latestAttempt: { state: "failed" } })).label).toBe("run failed");
    expect(nodeState(node({ conditions: ["output_missing", "stale"] })).label).toBe("output deleted");
    // An output that exists outside the reader's reach is not deleted.
    expect(nodeState(node({ conditions: ["output_unavailable"] }))).toEqual({ label: "output not available", tone: "muted" });
    expect(nodeState(node({ conditions: ["stale"], proposedParameters: { a: 1 } })).label).toBe("stale");
    expect(nodeState(node({ conditions: ["current"], proposedParameters: { a: 1 } })).label).toBe("edited");
    expect(nodeState(node({ conditions: ["never_run"] })).label).toBe("never run");
    expect(nodeState(node({ conditions: ["current"], latestAttempt: { state: "cancelled" } })).label).toBe("up to date");
  });
});

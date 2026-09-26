import { describe, expect, it } from "vitest";
import type { CanvasMember } from "./graph";
import type { WorkflowRun } from "./run-overlay";
import { lastObservedRun, workflowAssistantContext, workflowFacts } from "./assistant-context";

const node = { kind: "node", id: "s1", label: "Buffer 500 m", step: { id: "s1" } } as unknown as CanvasMember;
const source = { kind: "source", id: "t", name: "stations" } as unknown as CanvasMember;
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({ id: "r1", recipeId: "w", kind: "run_all", outcome: null, cancelled: false, startedAt: "2026-09-15T10:00:00Z", finishedAt: null, members: [], ...over });

/** Item 7's context and chips, as arithmetic. */
describe("the workflow assistant context", () => {
  it("carries the recipe, the selected step only for a node, and the last observed run or none", () => {
    expect(workflowAssistantContext("w", node, null)).toEqual({ page: "workflow", recipeId: "w", selectedStepId: "s1", lastRunId: null });
    expect(workflowAssistantContext("w", source, run({})).selectedStepId).toBeNull();
    expect(workflowAssistantContext("w", null, run({ id: "r9" })).lastRunId).toBe("r9");
  });
  it("the last observed run is the one in flight or shown, else the last to end, else none", () => {
    expect(lastObservedRun({ active: run({ id: "a" }), ended: run({ id: "e" }) })?.id).toBe("a");
    expect(lastObservedRun({ active: null, ended: run({ id: "e" }) })?.id).toBe("e");
    expect(lastObservedRun({ active: null, ended: null })).toBeNull();
  });
  it("words the chips: the workflow, the node only for a node, the run in progress or settled", () => {
    expect(workflowFacts("W", source, null)).toEqual({ page: "workflow", workflowName: "W", selectedStepLabel: null, run: null });
    expect(workflowFacts("W", node, run({})).run).toEqual({ kind: "running", startedAt: "2026-09-15T10:00:00Z" });
    expect(workflowFacts("W", node, run({ outcome: "failed", finishedAt: "2026-09-15T10:01:00Z" })).run).toEqual({ kind: "settled", outcome: "failed", finishedAt: "2026-09-15T10:01:00Z" });
    expect(workflowFacts("W", node, null).selectedStepLabel).toBe("Buffer 500 m");
  });
});

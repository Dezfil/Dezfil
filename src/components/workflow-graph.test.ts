import { describe, it, expect } from "vitest";
import { workflowGraph } from "./workflow-graph";
import type { WorkflowStep } from "./workflow-model";

const step = (o: Partial<WorkflowStep> & { id: string; name: string; reads: string[] }): WorkflowStep => ({
  id: o.id, ordinal: o.ordinal ?? 0, operation: o.operation ?? "sql_step",
  parameters: { name: o.name }, proposedParameters: o.proposedParameters ?? null, output: o.output ?? null,
  reads: o.reads, condition: o.condition ?? "never_run", conditions: o.conditions ?? [o.condition ?? "never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null,
});

describe("the card's graph", () => {
  it("lays sources in the first column and nodes by dependency, edges from present reads", () => {
    const g = workflowGraph([
      step({ id: "a", ordinal: 0, name: "stations_500m", reads: ["stations"] }),
      step({ id: "b", ordinal: 1, name: "district_reach", reads: ["districts", "stations_500m"] }),
      step({ id: "c", ordinal: 2, name: "reach_by_district", reads: ["district_reach"] }),
    ]);
    const at = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect(at("src:stations")).toMatchObject({ kind: "source", col: 0, row: 0 });
    expect(at("src:districts")).toMatchObject({ kind: "source", col: 0, row: 1 });
    expect(at("a").col).toBe(1);
    expect(at("b").col).toBe(2);
    expect(at("c").col).toBe(3);
    expect(g.cols).toBe(4);
    expect(g.rows).toBe(2);
    expect(g.edges).toEqual([
      { from: "src:stations", to: "a" },
      { from: "src:districts", to: "b" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("matches a read to a planned output before any run, through the registry's naming", () => {
    const g = workflowGraph([
      step({ id: "a", ordinal: 0, name: "Chain One", reads: ["stations"] }),
      step({ id: "b", ordinal: 1, name: "tally", reads: ["chain_one"] }),
    ]);
    expect(g.edges).toContainEqual({ from: "a", to: "b" });
    expect(g.nodes.filter((n) => n.kind === "source").map((n) => n.name)).toEqual(["stations"]);
  });

  it("draws the edge when a downstream read names a producer's pending rename", () => {
    const g = workflowGraph([
      { ...step({ id: "a", ordinal: 0, name: "old_name", reads: ["stations"], output: { id: "t", name: "old_name" } }), proposedParameters: { name: "new_name" } },
      step({ id: "b", ordinal: 1, name: "tally", reads: ["new_name"] }),
    ]);
    expect(g.edges).toContainEqual({ from: "a", to: "b" });
    expect(g.nodes.filter((n) => n.kind === "source").map((n) => n.name)).toEqual(["stations"]);
  });

  it("is empty for an empty workflow", () => {
    expect(workflowGraph([])).toEqual({ nodes: [], edges: [], cols: 0, rows: 0 });
  });
});

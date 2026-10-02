import { describe, it, expect } from "vitest";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import type { WorkflowStep } from "../workflow-model";
import { canvasGraph, type NodeMember, type SourceMember } from "./graph";
import { removalPlan, sourceKeptBecause } from "./removal-model";

const OPS = [
  { id: "sql_step", label: "SQL step", group: "Data", symbol: "code", inputs: [], outputGeometry: { kind: "probed" } },
  {
    id: "buffer", label: "Buffer", group: "Proximity", symbol: "buffer",
    inputs: [{ name: "input", label: "Features to buffer", accepts: ["any"], required: true }],
    outputGeometry: { kind: "fixed", geometry: "polygon" },
  },
] as unknown as OperationDef[];
const table = (name: string): TableListing => ({ id: `t_${name}`, name, geometryType: "POINT", rowCount: 1 }) as unknown as TableListing;
const step = (o: Partial<WorkflowStep> & { id: string; operation: string; parameters: Record<string, unknown> }): WorkflowStep => ({
  ordinal: 0, proposedParameters: null, output: null, reads: [], condition: "never_run", conditions: ["never_run"],
  causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null, ...o,
});
const member = (g: ReturnType<typeof canvasGraph>, id: string) => g.members.find((m) => m.id === id || (m.kind === "source" && m.name === id))!;

describe("the removal plan", () => {
  // A produced output is the listed dataset of the same identity.
  const steps = [
    step({ id: "a", operation: "buffer", parameters: { input: "stations", name: "a_out" }, reads: ["stations"], output: { id: "t_a_out", name: "a_out" }, conditions: ["current"] }),
    step({ id: "b", ordinal: 1, operation: "buffer", parameters: { input: "a_out", name: "b_out" }, reads: ["a_out"] }),
    step({ id: "c", ordinal: 2, operation: "buffer", parameters: { input: "b_out", name: "c_out" }, reads: ["b_out"] }),
    step({ id: "d", ordinal: 3, operation: "buffer", parameters: { input: "stations", name: "d_out" }, reads: ["stations"], output: { id: "o2", name: "d_out" }, conditions: ["output_missing"] }),
  ];
  it("says a produced dataset stays and who goes on reading it", () => {
    const g = canvasGraph({ steps, layout: { steps: {}, sources: {} }, tables: [table("stations"), table("a_out")], operations: OPS });
    const plan = removalPlan(member(g, "a") as NodeMember, g, [table("stations"), table("a_out")]);
    expect(plan.state).toBe("exists");
    expect(plan.readers.map((r) => r.id)).toEqual(["b"]);
    expect(plan.sentence).toBe("The dataset a_out stays. Buffer goes on reading it as a workspace table.");
  });
  it("promises no dataset for a deleted one, and says a never-run node's reader stays bound to a missing name", () => {
    const g = canvasGraph({ steps, layout: { steps: {}, sources: {} }, tables: [table("stations"), table("a_out")], operations: OPS });
    expect(removalPlan(member(g, "d") as NodeMember, g, [table("stations"), table("a_out")])).toMatchObject({ state: "deleted", dataset: "d_out" });
    const never = removalPlan(member(g, "b") as NodeMember, g, [table("stations"), table("a_out")]);
    expect(never.state).toBe("never");
    expect(never.sentence).toBe("It has made no dataset. Buffer reads b_out and stays bound to a name nothing produces.");
    expect(removalPlan(member(g, "c") as NodeMember, g, []).sentence).toBe("It has made no dataset.");
  });
  it("keeps a source a read or a lineage needs, and lets a loose one go", () => {
    const g = canvasGraph({
      // A pending edit moved a's input from old to stations: old is named
      // by recorded lineage only.
      steps: [step({ id: "a", operation: "buffer", parameters: { input: "old", name: "a_out" }, proposedParameters: { input: "stations", name: "a_out" }, reads: ["stations"], inputs: [{ id: "t_old", name: "old" }], output: { id: "o", name: "a_out" }, conditions: ["current"] })],
      layout: { steps: {}, sources: { spare: { x: 0, y: 0 }, old: { x: 0, y: 0 } } },
      tables: [table("stations"), table("spare"), table("old")],
      operations: OPS,
    });
    expect(sourceKeptBecause(member(g, "stations") as SourceMember, g)).toBe("stations stays: a node reads it.");
    expect(sourceKeptBecause(member(g, "old") as SourceMember, g)).toBe("old stays: a node’s recorded lineage names it.");
    expect(sourceKeptBecause(member(g, "spare") as SourceMember, g)).toBeNull();
  });
});

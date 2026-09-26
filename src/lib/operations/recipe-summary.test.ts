import { describe, it, expect } from "vitest";
import type { OperationJob } from "@/lib/metadata/jobs";
import type { RecipeStep } from "@/lib/metadata/recipes";
import { summarizeRecipe, type SummaryInput } from "./recipe-summary";
import type { ConditionKind, StepCondition } from "./step-condition";

let n = 0;
function node(o: {
  name: string;
  reads?: string[];
  output?: string | null;
  conditions?: ConditionKind[];
  attempt?: OperationJob["state"] | null;
  proposed?: boolean;
  sql?: string;
}): SummaryInput {
  const id = `s${++n}`;
  const step: RecipeStep = {
    id,
    recipeId: "r",
    ordinal: n,
    operation: "sql_step",
    parameters: { name: o.name, sql: o.sql ?? "" },
    proposedParameters: o.proposed ? { name: o.name, sql: "SELECT 2" } : null,
    outputTableId: o.output === undefined ? null : o.output,
    outputTableName: o.output ? o.name : null,
    origin: null,
    proposedOrigin: null,
    lastSuccessAt: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const conditions: ConditionKind[] = o.conditions ?? (o.output ? ["current"] : ["never_run"]);
  const condition: StepCondition = {
    stepId: id,
    conditions,
    primary: conditions[0],
    causes: [],
    missingInputs: [],
  };
  const latestAttempt = o.attempt ? ({ state: o.attempt } as OperationJob) : null;
  return { step, condition, latestAttempt, reads: o.reads ?? [] };
}
const live = (...ids: string[]) => new Map(ids.map((id) => [id, `${id}.parquet`]));

describe("a workflow's summary", () => {
  it("an empty workflow is empty", () => {
    expect(summarizeRecipe([], live())).toEqual({
      nodes: 0, sources: 0, liveOutputs: 0, status: "empty", count: 0,
    });
  });

  it("follows the precedence: cannot run, in progress, failed, run again, never run", () => {
    const broken = node({ name: "a", conditions: ["broken"] });
    const running = node({ name: "b", attempt: "running" });
    const failed = node({ name: "c", output: "t_c", attempt: "failed" });
    const stale = node({ name: "d", output: "t_d", conditions: ["stale"] });
    const fresh = node({ name: "e" });
    const all = [broken, running, failed, stale, fresh];
    expect(summarizeRecipe(all, live("t_c", "t_d")).status).toBe("cannot_run");
    expect(summarizeRecipe(all.slice(1), live("t_c", "t_d")).status).toBe("in_progress");
    expect(summarizeRecipe(all.slice(2), live("t_c", "t_d")).status).toBe("failed");
    expect(summarizeRecipe(all.slice(3), live("t_d"))).toMatchObject({ status: "run_again", count: 1 });
    expect(summarizeRecipe([fresh], live())).toMatchObject({ status: "never_run", count: 1 });
  });

  it("counts a node once in run-again when it is stale and edited, and counts an output that was deleted", () => {
    const both = node({ name: "a", output: "t_a", conditions: ["stale"], proposed: true });
    const gone = node({ name: "b", output: "t_b", conditions: ["output_missing"] });
    const edited = node({ name: "c", output: "t_c", proposed: true });
    const ok = node({ name: "d", output: "t_d" });
    const s = summarizeRecipe([both, gone, edited, ok], live("t_a", "t_c", "t_d"));
    expect(s.status).toBe("run_again");
    expect(s.count).toBe(3);
    expect(s.liveOutputs).toBe(3);
  });

  it("tells wholly from partly never run, and a cancelled attempt alone is up to date", () => {
    const ran = node({ name: "a", output: "t_a", attempt: "succeeded" });
    const not = node({ name: "b" });
    expect(summarizeRecipe([not, node({ name: "c" })], live())).toMatchObject({ status: "never_run", count: 2 });
    expect(summarizeRecipe([ran, not], live("t_a"))).toMatchObject({ status: "partly_never_run", count: 1 });
    const cancelled = node({ name: "d", output: "t_d", attempt: "cancelled" });
    expect(summarizeRecipe([ran, cancelled], live("t_a", "t_d"))).toMatchObject({ status: "up_to_date", count: 0 });
  });

  it("counts distinct external sources, not the outputs its own nodes produce", () => {
    const a = node({ name: "stations_500m", reads: ["stations"] });
    const b = node({ name: "district_reach", reads: ["districts", "stations_500m"] });
    const c = node({ name: "reach_by_district", reads: ["district_reach", "districts"] });
    const s = summarizeRecipe([a, b, c], live());
    expect(s.nodes).toBe(3);
    expect(s.sources).toBe(2);
  });
});

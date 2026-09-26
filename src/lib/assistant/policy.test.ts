import { describe, expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { admits, admittedTools, policyFor } from "./policy";

describe("the page action policy", () => {
  it("derives the policy from the context's page: full for the builder and no context, read-only for /sql and workflow", () => {
    expect(policyFor(undefined)).toBe("full");
    expect(policyFor({ page: "builder", mapId: "m", selectedLayerId: null })).toBe("full");
    expect(policyFor({ page: "sql", draft: "", selection: null, lastExecution: null })).toBe("read_only");
    expect(policyFor({ page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null })).toBe("read_only");
  });

  it("the full policy offers every generated tool unchanged", () => {
    const tools = buildTools();
    expect(admittedTools("full", tools)).toBe(tools);
  });

  it("the read-only policy admits exactly the unconditional read-only operations", () => {
    const tools = buildTools();
    const admitted = admittedTools("read_only", tools);
    const names = admitted.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["run_sql", "read_table_catalogue", "get_map"]));
    expect(names).not.toContain("update_map");
    for (const tool of admitted) {
      expect(tool.effects.readOnly, tool.name).toBe(true);
      expect(tool.effects.writes, tool.name).toEqual([]);
      expect(tool.effects.planningArgument, tool.name).toBeUndefined();
      expect(tool.confirm, tool.name).toBe(false);
      expect(tool.confirmWhen, tool.name).toBeUndefined();
    }
    // Every excluded tool declares a write on some argument or a planning form.
    for (const tool of tools) {
      if (names.includes(tool.name)) continue;
      expect(!tool.effects.readOnly || tool.effects.planningArgument !== undefined, tool.name).toBe(true);
    }
    // The registry holds conditional operations, so the exclusion is exercised, not vacuous.
    expect(tools.some((t) => t.effects.planningArgument !== undefined)).toBe(true);
  });

  it("admits answers per tool the way the set is built", () => {
    const tools = buildTools();
    for (const tool of tools) {
      expect(admits("read_only", tool)).toBe(admittedTools("read_only", tools).includes(tool));
      expect(admits("full", tool)).toBe(true);
    }
  });
});

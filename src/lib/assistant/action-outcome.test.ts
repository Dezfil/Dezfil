import { describe, expect, it } from "vitest";
import { buildTools } from "@/lib/tools/tools";
import { actionEffects, actionOutcome } from "./action-metadata";
import { entryFromResult } from "@/components/builder/assistant/record-projection";
import type { ToolResult } from "@/lib/tools/execute";

/**
 * A read-only operation that answers 5xx changed nothing, so its outcome
 * is a refusal carrying its own code, not the uncertainty reserved for a
 * mutation whose result is unknown. The effects come from the operations'
 * own declarations, never from a list of names kept here.
 */
const tool = (name: string) => buildTools().find((entry) => entry.name === name)!;
const failed = (code: string, message: string, status: number): ToolResult => ({
  status,
  ok: false,
  body: { error: { code, message } },
});

describe("a failed read is not an uncertain outcome", () => {
  it("a read-only operation's 5xx is refused", () => {
    const read = tool("run_sql");
    expect(read.effects.readOnly).toBe(true);
    const result = failed("query_timeout", "The query exceeded its time budget.", 504);
    expect(actionOutcome(result, actionEffects(read, { sql: "SELECT 1" }))).toEqual({
      outcome: "refused",
    });
  });

  it("a rendering read's 5xx is refused too", () => {
    const read = tool("export_map_image");
    expect(read.effects.readOnly).toBe(true);
    const result = failed("render_failed", "The image could not be rendered.", 502);
    expect(actionOutcome(result, actionEffects(read, { id: "map" }))).toEqual({
      outcome: "refused",
    });
  });

  it("a mutation's 5xx is still uncertain", () => {
    const write = tool("update_layer");
    expect(write.effects.readOnly).toBe(false);
    const result = failed("internal_error", "An unexpected server error occurred.", 500);
    expect(actionOutcome(result, actionEffects(write, { id: "layer" }))).toEqual({
      outcome: "uncertain",
    });
  });

  it("a planning call of a mutation is a read, so its 5xx is refused", () => {
    const write = tool("compute_fill");
    const planning = actionEffects(write, { id: "layer", plan: true });
    expect(planning.readOnly).toBe(true);
    const result = failed("internal_error", "An unexpected server error occurred.", 500);
    expect(actionOutcome(result, planning).outcome).toBe("refused");
  });

  it("a 4xx and the successful outcomes are untouched by the effects", () => {
    const read = tool("run_sql");
    const write = tool("update_layer");
    const refusal = failed("sql_error", "The SQL failed to parse or execute.", 400);
    expect(actionOutcome(refusal, actionEffects(read, {})).outcome).toBe("refused");
    expect(actionOutcome(refusal, actionEffects(write, { id: "layer" })).outcome).toBe("refused");
    const ok: ToolResult = { status: 200, ok: true, body: {} };
    expect(actionOutcome(ok, actionEffects(write, { id: "layer" })).outcome).toBe("succeeded");
    const accepted: ToolResult = { status: 202, ok: true, body: { run: { id: "run" } } };
    expect(actionOutcome(accepted, actionEffects(write, { id: "layer" }))).toEqual({
      outcome: "accepted",
      jobId: "run",
    });
  });

  it("the pane reads the failed read's own code and sentence, not the uncertain note", () => {
    const read = tool("run_sql");
    const result = failed("query_timeout", "The query exceeded its time budget.", 504);
    const effects = actionEffects(read, { sql: "SELECT 1" });
    const entry = entryFromResult(
      { id: "call", tool: "run_sql", label: "Ran the SQL", status: "running", inputs: [], omitted: false },
      {
        type: "tool_result",
        id: "call",
        tool: "run_sql",
        ok: false,
        body: result.body,
        effects,
        ...actionOutcome(result, effects),
      },
    );
    expect(entry.status).toBe("refused");
    expect(entry.failure).toEqual({
      code: "query_timeout",
      message: "The query exceeded its time budget.",
    });
  });
});

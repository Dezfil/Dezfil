import { describe, expect, it } from "vitest";
import { parseAssistantContext, CONTEXT_MAX_BYTES } from "./context";

const sql = { page: "sql", draft: "  SELECT 'draft';\n", selection: "'draft'", lastExecution: null };
describe("context validation", () => {
  it("distinguishes all pages, null selections and omitted context", () => {
    expect(parseAssistantContext(undefined)).toBeUndefined();
    for (const context of [sql, { page: "builder", mapId: "m", selectedLayerId: null }, { page: "workflow", recipeId: "r", selectedStepId: null, lastRunId: null }]) {
      expect(parseAssistantContext(context)).toEqual(context);
    }
  });
  it("preserves each exact draft/executed SQL pair with success or error", () => {
    for (const lastExecution of [
      { sql: " SELECT 'earlier';\n", error: { code: "query_failed", message: "Column absent" } },
      { sql: " SELECT 1; ", result: { totalRows: 100, returnedRows: 20, truncated: true, columns: [{ name: "1", type: "INTEGER" }], elapsedMs: 0.25 } },
    ]) expect(parseAssistantContext({ ...sql, lastExecution })).toEqual({ ...sql, lastExecution });
  });
  it("refuses malformed and preview-shaped executions", () => {
    for (const value of [null, {}, [], { page: "sql" }, { page: "builder", mapId: "m" },
      { page: "builder", mapId: "m", selectedLayerId: 4 },
      { ...sql, extra: true }, { ...sql, lastExecution: 4 }, { ...sql, lastExecution: "x" }, { ...sql, lastExecution: { preview: [] } },
      { ...sql, lastExecution: { sql: "x", result: {}, error: { code: "x", message: "x" } } },
    ]) expect(() => parseAssistantContext(value)).toThrowError(expect.objectContaining({ code: "assistant_context_invalid" }));
  });
  it("holds the UTF-8 JSON byte limit at and above the boundary", () => {
    const base = { ...sql, draft: "" };
    const bytes = CONTEXT_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
    const context = { ...base, draft: "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2) };
    expect(Buffer.byteLength(JSON.stringify(context))).toBe(CONTEXT_MAX_BYTES);
    expect(parseAssistantContext(context)).toEqual(context);
    expect(() => parseAssistantContext({ ...context, draft: context.draft + "x" })).toThrowError(expect.objectContaining({ code: "assistant_context_too_large" }));
  });
});

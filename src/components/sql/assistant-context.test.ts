import { describe, expect, it } from "vitest";
import { executedSnapshot, failedSnapshot, sqlAssistantContext, sqlFacts } from "./assistant-context";

/** The /sql context's arithmetic: the
 * exact draft and selection, and the retained snapshot's pairing of the
 * SQL that ran with its own answer, which later edits never rebuild.
 * The captured request itself is the browser suite's. */
describe("the /sql assistant context", () => {
  const result = { columns: [{ name: "n", type: "BIGINT" }], rowCount: 1204, preview: [{ n: 1 }, { n: 2 }], previewTruncated: true, runtimeMs: 812 };
  it("carries the draft exactly, the selection or null, and no execution before a run", () => {
    expect(sqlAssistantContext("SELECT 1;\n", "", null)).toEqual({ page: "sql", draft: "SELECT 1;\n", selection: null, lastExecution: null });
    expect(sqlAssistantContext("SELECT 1;", "SELECT 1", null).selection).toBe("SELECT 1");
  });
  it("pairs the executed SQL with its summary, and a failure with its coded error", () => {
    const ok = executedSnapshot("SELECT n FROM t", result);
    expect(ok).toEqual({ sql: "SELECT n FROM t", result: { totalRows: 1204, returnedRows: 2, truncated: true, columns: [{ name: "n", type: "BIGINT" }], elapsedMs: 812 } });
    expect(failedSnapshot("SELECT absent", "sql_error", "Missing column")).toEqual({ sql: "SELECT absent", error: { code: "sql_error", message: "Missing column" } });
  });
  it("keeps the snapshot's SQL when the draft has moved on", () => {
    const snapshot = executedSnapshot("SELECT n FROM t", result);
    const context = sqlAssistantContext("SELECT n FROM t WHERE n > 1", "", snapshot);
    expect(context.lastExecution).toEqual(snapshot);
    expect(context.draft).toBe("SELECT n FROM t WHERE n > 1");
  });
  it("words the chips from the same draft and snapshot", () => {
    expect(sqlFacts("SELECT 1;", true, null)).toEqual({ page: "sql", draft: "SELECT 1;", edited: true, execution: null });
    expect(sqlFacts("x", false, executedSnapshot("x", result)).execution).toEqual({ kind: "result", rows: 1204, elapsedMs: 812 });
    expect(sqlFacts("x", false, failedSnapshot("x", "sql_error", "Missing column")).execution).toEqual({ kind: "error", message: "Missing column" });
  });
});

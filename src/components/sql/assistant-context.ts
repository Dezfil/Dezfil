import type { AssistantContext, SqlExecutionSummary } from "@/lib/assistant/context";
import type { PageFacts } from "../builder/assistant/talking-about";
import type { QueryResult } from "../query-types";

/**
 * The /sql page's assistant context (SQL): the exact draft, the exact
 * selection or none, and the last execution as a retained snapshot,
 * kept apart from what the results area shows so a table preview or a
 * draft edit neither replaces nor clears it. The snapshot is taken at
 * the execution from the SQL that ran and its answer, never rebuilt
 * from later editor contents. Pure.
 */
export type SqlExecutionSnapshot =
  | { sql: string; result: SqlExecutionSummary }
  | { sql: string; error: { code: string; message: string } };

/** The snapshot of a successful execution: the SQL that ran and its
 * summary, as the API answered it. */
export function executedSnapshot(sql: string, result: QueryResult): SqlExecutionSnapshot {
  return {
    sql,
    result: {
      totalRows: result.rowCount,
      returnedRows: result.preview.length,
      truncated: result.previewTruncated,
      columns: result.columns.map((column) => ({ name: column.name, type: column.type })),
      elapsedMs: result.runtimeMs,
    },
  };
}

/** The snapshot of a failed execution: the SQL that ran and its coded error. */
export function failedSnapshot(sql: string, code: string, message: string): SqlExecutionSnapshot {
  return { sql, error: { code, message } };
}

/** What every message from /sql carries. */
export type SqlAssistantContext = Extract<AssistantContext, { page: "sql" }>;
export type SqlPageFacts = Extract<PageFacts, { page: "sql" }>;

export function sqlAssistantContext(draft: string, selection: string, execution: SqlExecutionSnapshot | null): SqlAssistantContext {
  return { page: "sql", draft, selection: selection === "" ? null : selection, lastExecution: execution };
}

/** The chips' facts, from the same draft and the same snapshot. */
export function sqlFacts(draft: string, edited: boolean, execution: SqlExecutionSnapshot | null): SqlPageFacts {
  const fact = execution === null ? null
    : "result" in execution ? { kind: "result" as const, rows: execution.result.totalRows, elapsedMs: execution.result.elapsedMs }
    : { kind: "error" as const, message: execution.error.message };
  return { page: "sql", draft, edited, execution: fact };
}

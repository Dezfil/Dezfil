import { ApiError } from "@/lib/api/errors";

export const CONTEXT_MAX_BYTES = 64 * 1024;
export interface SqlExecutionSummary {
  totalRows: number;
  returnedRows: number;
  truncated: boolean;
  columns: { name: string; type: string }[];
  elapsedMs: number;
}
export type AssistantContext =
  | {
      page: "builder"; mapId: string; selectedLayerId: string | null;
      /** The builder's active theme, for the automatic map check's render
       * light when absent. */
      appearance?: "light" | "dark";
    }
  | {
      page: "sql";
      draft: string;
      selection: string | null;
      lastExecution: null | { sql: string; result: SqlExecutionSummary } | { sql: string; error: { code: string; message: string } };
    }
  | { page: "workflow"; recipeId: string; selectedStepId: string | null; lastRunId: string | null };

function invalid(): never {
  throw new ApiError("assistant_context_invalid", "The submitted page context is malformed or refers to an incompatible object.", 400);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) invalid();
  return record;
}
function isString(value: unknown): value is string { return typeof value === "string"; }
function identity(value: unknown) { return isString(value) && value.trim().length > 0; }
function selection(value: unknown) { return value === null || identity(value); }
function count(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0; }

/** Validate browser-owned snapshots without trimming, replacing or re-pairing SQL. */
export function parseAssistantContext(value: unknown): AssistantContext | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CONTEXT_MAX_BYTES) {
    throw new ApiError("assistant_context_too_large", "Page context exceeds 64 KiB of UTF-8 JSON.", 413);
  }
  const page = (value as { page?: unknown } | null)?.page;
  if (page === "builder") {
    const record = value as Record<string, unknown>;
    const keys = ["page", "mapId", "selectedLayerId", ...("appearance" in record ? ["appearance"] : [])];
    const context = object(value, keys);
    if (!identity(context.mapId) || !selection(context.selectedLayerId)) invalid();
    // The builder's theme for the automatic check.
    if ("appearance" in context && context.appearance !== "light" && context.appearance !== "dark") invalid();
  } else if (page === "workflow") {
    const context = object(value, ["page", "recipeId", "selectedStepId", "lastRunId"]);
    if (!identity(context.recipeId) || !selection(context.selectedStepId) || !selection(context.lastRunId)) invalid();
  } else if (page === "sql") {
    const context = object(value, ["page", "draft", "selection", "lastExecution"]);
    if (!isString(context.draft) || !(context.selection === null || isString(context.selection))) invalid();
    if (context.lastExecution !== null) {
      const raw = context.lastExecution as { result?: unknown } | null;
      const kind = raw && typeof raw === "object" && "result" in raw ? "result" : "error";
      const execution = object(raw, ["sql", kind]);
      if (!isString(execution.sql)) invalid();
      if (kind === "error") {
        const error = object(execution.error, ["code", "message"]);
        if (!identity(error.code) || !isString(error.message)) invalid();
      } else {
        const result = object(execution.result, ["totalRows", "returnedRows", "truncated", "columns", "elapsedMs"]);
        if (!count(result.totalRows) || !count(result.returnedRows) || Number(result.returnedRows) > Number(result.totalRows)
          || typeof result.truncated !== "boolean" || !Array.isArray(result.columns)
          || typeof result.elapsedMs !== "number" || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) invalid();
        for (const column of result.columns) {
          const field = object(column, ["name", "type"]);
          if (!isString(field.name) || !isString(field.type)) invalid();
        }
      }
    }
  } else invalid();
  return value as AssistantContext;
}

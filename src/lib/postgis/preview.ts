import { withTrustedMutation } from "@/lib/trusted-mutation";
import { readBudgetedRows } from "@/lib/query/budget-reader";
import { ResultBudget, jsonBytes } from "@/lib/query/result-budget";
import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { ApiError, EvaluationCancelled } from "@/lib/api/errors";
import { assertPreviewActive } from "./source-owner";
import type { RemoteColumn } from "./access";
import {
  assertFilterSafe,
  fetchColumns,
  pgIdent,
  readConnectionHealth,
  withPg,
  type ConnectionHealth,
  type ConnectionTarget,
} from "./access";
import { requireTarget } from "./import";

const PREVIEW_ROWS = 5;
const PREVIEW_FIELDS = new Set(["schema", "table", "filter"]);

export interface PostgisPreviewRequest {
  schema: string;
  table: string;
  filter?: string;
}

export interface PostgisPreviewColumn {
  name: string;
  type: string;
  spatialKind: "geometry" | "geography" | null;
}

export interface PostgisPreviewResult {
  columns: PostgisPreviewColumn[];
  rows: Record<string, unknown>[];
  connectionHealth: ConnectionHealth;
}

/** The preview contract is deliberately smaller than import: no credentials,
 * source SQL, destination name, or caller-controlled limit cross this door. */
export function resolvePostgisPreviewRequest(
  input: unknown,
): PostgisPreviewRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(
      "invalid_request",
      "Expected a JSON body with schema and table.",
      400,
    );
  }
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((field) => !PREVIEW_FIELDS.has(field))) {
    throw new ApiError(
      "invalid_request",
      "Preview accepts only schema, table, and filter.",
      400,
    );
  }
  if (typeof body.schema !== "string" || !body.schema) {
    throw new ApiError("invalid_request", "schema is required.", 400);
  }
  if (typeof body.table !== "string" || !body.table) {
    throw new ApiError("invalid_request", "table is required.", 400);
  }
  if (body.filter !== undefined && typeof body.filter !== "string") {
    throw new ApiError(
      "invalid_request",
      "The filter must be a string.",
      400,
    );
  }
  const filter = typeof body.filter === "string" ? body.filter.trim() : "";
  return {
    schema: body.schema,
    table: body.table,
    ...(filter ? { filter } : {}),
  };
}

function previewColumns(columns: RemoteColumn[]): PostgisPreviewColumn[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.udt,
    spatialKind:
      column.udt === "geometry" || column.udt === "geography"
        ? column.udt
        : null,
  }));
}

/** Preview keeps the source relation and filter contract used by imports, but
 * projects spatial values as readable WKT instead of import-only WKB. */
function composePreviewSelect(
  schema: string,
  table: string,
  columns: RemoteColumn[],
  filter?: string,
): string {
  if (columns.length === 0) {
    throw new ApiError(
      "not_found",
      `Table ${schema}.${table} has no columns or does not exist.`,
      404,
    );
  }
  const projection = columns.map((column) =>
    column.udt === "geometry" || column.udt === "geography"
      ? `ST_AsText(${pgIdent(column.name)}) AS ${pgIdent(column.name)}`
      : pgIdent(column.name),
  );
  let sql = `SELECT ${projection.join(", ")} FROM ${pgIdent(schema)}.${pgIdent(table)}`;
  if (filter && filter.trim()) {
    assertFilterSafe(filter);
    sql += ` WHERE ${filter.trim()}`;
  }
  return `${sql} LIMIT ${PREVIEW_ROWS}`;
}

/** Source engines may quote arbitrary failing expressions. The preview wire
 * deliberately substitutes a stable sentence instead of relaying internals. */
export function previewReadError(error: unknown): ApiError {
  if (error instanceof EvaluationCancelled) throw error;
  if (error instanceof ApiError && (error.code === "query_timeout" || error.code === "query_result_too_large" || error.code === "engine_memory_exceeded" || error.code === "data_processing_timeout")) return error;
  return new ApiError(
    "malformed_file",
    "The preview could not be read from PostGIS. Check the filter expression.",
    422,
  );
}

/** Read at most five source rows through the same guarded SELECT as import. */
export async function buildPostgisPreview(
  target: ConnectionTarget,
  request: PostgisPreviewRequest,
  observeHealth?: (health: ConnectionHealth) => void,
  signal?: AbortSignal,
): Promise<PostgisPreviewResult> {
  return withPg(target, async (conn, passthrough) => {
    // The attachment still reads the source's versions: that read is part
    // of the guarded sequence pinned, and a caller may observe it.
    // Nothing persists it any more.
    const connectionHealth = await readConnectionHealth(conn, passthrough);
    observeHealth?.(connectionHealth);
    const columns = await fetchColumns(
      conn,
      passthrough,
      request.schema,
      request.table,
    );
    const select = composePreviewSelect(
      request.schema,
      request.table,
      columns,
      request.filter,
    );
    try {
      const returnedColumns = previewColumns(columns);
      const budget = new ResultBudget();
      // Health belongs to the attachment, not the returned REST answer.
      budget.take(jsonBytes({ columns: returnedColumns, rows: [] }));
      const geometryColumns = new Set(returnedColumns.filter(c => c.spatialKind !== null).map(c => c.name));
      const rows = await readBudgetedRows(conn, `SELECT * FROM ${passthrough(select)}`, budget,
        geometryColumns, false, () => signal?.aborted ?? false);
      return {
        columns: returnedColumns,
        rows,
        connectionHealth,
      };
    } catch (error) {
      throw previewReadError(error);
    }
  }, { signal, preview: true });
}

/** Preview a saved connection. A read: success, a source
 * refusal, the source ceiling and a departed caller all leave the stored
 * status memory exactly as they found it. The connection test, an import
 * and a refresh remain the operations that write it. */
export async function previewPostgis(
  scope: AccountScope,
  connectionId: string,
  input: unknown,
  build: typeof buildPostgisPreview = buildPostgisPreview,
  signal?: AbortSignal,
): Promise<Omit<PostgisPreviewResult, "connectionHealth">> {
  return withTrustedMutation({ kind: "interactive-read", name: "PostGIS preview", signal }, async () => {
    assertPreviewActive(signal);
    const request = resolvePostgisPreviewRequest(input);
    const { target } = requireTarget(scope, connectionId);
    let result: PostgisPreviewResult;
    try {
      result = await build(target, request, undefined, signal);
      assertPreviewActive(signal);
      requireOwnedResource(scope, "connection", connectionId);
    } catch (caught) {
      throw signal?.aborted ? new EvaluationCancelled() : caught;
    }
    return { columns: result.columns, rows: result.rows };
  });
}

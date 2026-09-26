import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { offsetPosition } from "./engine-message";

/**
 * First hardening layer: only read-only SELECT statements pass (spec:
 * Query). Classification uses DuckDB's own parser via json_serialize_sql —
 * which serializes SELECT statements only — rather than a fragile keyword
 * blocklist. The hardened session (duckdb.ts) is the second layer.
 */

const REJECTION =
  "Only read-only SELECT queries are accepted. Statements that change data " +
  "or schema, alter settings, load extensions, attach databases, or write " +
  "files are rejected.";

interface SerializedSql {
  error: boolean;
  error_type?: string;
  error_message?: string;
  /** The parser's 0-based offset into the statement, as a string. */
  position?: unknown;
  statements?: unknown[];
}

export async function assertReadOnlySelect(
  conn: DuckDBConnection,
  sql: string,
): Promise<void> {
  const reader = await conn.runAndReadAll(
    "SELECT json_serialize_sql(?::VARCHAR) AS j",
    [sql],
  );
  const parsed = JSON.parse(
    String(reader.getRowObjects()[0].j),
  ) as SerializedSql;

  if (parsed.error) {
    // The parser accepted the syntax but it is not a SELECT statement.
    if (parsed.error_type === "not implemented") {
      throw new ApiError("sql_rejected", REJECTION, 400);
    }
    // Genuine parse problem — surface the engine's own message, and where
    // the parser stopped, in the user's coordinates.
    const position = offsetPosition(sql, parsed.position);
    throw new ApiError(
      "sql_error",
      parsed.error_message ?? "The query could not be parsed.",
      400,
      position ? { position } : {},
    );
  }

  if ((parsed.statements?.length ?? 0) !== 1) {
    throw new ApiError(
      "sql_rejected",
      "Send exactly one statement per query.",
      400,
    );
  }
}

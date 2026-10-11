import { ApiError } from "@/lib/api/errors";
import { projectionRejection } from "./projection-policy";

/**
 * DuckDB appends the statement it ran to binder/parser/catalog errors —
 * a `LINE n:` quote with a caret under the offending token. For user SQL
 * the statement the server actually ran is the internal probe rewrite
 * (`DESCRIBE SELECT * FROM (…) AS q`), so the quoted block leaks
 * implementation vocabulary into a user-facing sentence. The readable
 * diagnosis always precedes the block: keep it, drop the quote.
 *
 * Only the full quote shape is trimmed — a `LINE n:` line with a caret
 * line under it. A diagnostic that merely begins a line with `LINE n:`
 * (reachable via error()) is content, not the quote, and stays.
 */
export function stripStatementQuote(message: string): string {
  return message.replace(/\n\s*LINE \d+:[^\n]*\n\s*\^[\s\S]*$/, "").trimEnd();
}

/** A 1-based line and column into the SQL the user submitted. */
export interface SqlPosition {
  line: number;
  column: number;
}

/** A 0-based character offset into the SQL, as the parser reports it
 * (json_serialize_sql's `position`), turned into the 1-based line and
 * column the editor marks. Null when the offset is not a usable number.
 * */
export function offsetPosition(
  sql: string,
  offset: unknown,
): SqlPosition | null {
  const at = typeof offset === "string" ? Number(offset) : offset;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) return null;
  const clamped = Math.min(at, sql.length);
  const before = sql.slice(0, clamped);
  const line = before.split("\n").length;
  const column = clamped - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/**
 * Read the engine's `LINE n:` / caret block back into the user's own
 * coordinates. The caret line is padded to sit under the quoted statement
 * *including* its `LINE n: ` header, so the header's width comes off
 * first. On line one the quoted statement is the probe wrapper around the
 * user's SQL — `prefix` is that wrapper's opening text — so its length
 * comes off too; a caret that lands inside the wrapper itself, or a
 * line-one quote that is not the wrapper, yields null rather than a wrong
 * mark. Later lines quote the user's text directly.
 */
export function enginePosition(
  message: string,
  prefix: string,
): SqlPosition | null {
  const m = /\n\s*LINE (\d+): ([^\n]*)\n( *)\^/.exec(message);
  if (!m) return null;
  const line = Number(m[1]);
  const quoted = m[2];
  const caret = m[3].length - `LINE ${m[1]}: `.length;
  if (!Number.isFinite(line) || line < 1 || caret < 0) return null;
  if (line === 1) {
    if (!quoted.startsWith(prefix)) return null;
    const column = caret - prefix.length;
    if (column < 0) return null;
    return { line: 1, column: column + 1 };
  }
  return { line, column: caret + 1 };
}

export const UNKNOWN_TABLE_MESSAGE = "The query refers to an unknown table.";

/** A resource evaluation's refusal of a reference that binds nothing the
 * caller can reach. Its message is ours, built from the reference as written,
 * and is already safe: no engine diagnostic is behind it, so no sanitizer
 * rewrites it, even when the name reads like a file word. */
export class DatasetUnavailable extends ApiError {
  /** The reference as it was written. */
  readonly written: string;
  constructor(written: string) {
    super("sql_error", `The dataset "${written}" is not available to you.`, 400);
    this.written = written;
  }
}
export const DATASET_READ_MESSAGE = "The query's dataset could not be read.";
const FAILED_QUERY_MESSAGE = "The query could not be completed.";
const ENGINE_PREFIX = /^(?:Catalog|Binder|Parser|Conversion|Invalid(?: Input| Type)?|IO|Permission|Not implemented|Internal|Transaction|Constraint|Serialization|Connection|Syntax|Type) Error:/i;
const ABSENT_TABLE = /(?:Catalog Error:\s*)?(?:Table|Schema|Catalog) with name [\s\S]*? does not exist[!.]?/i;
const FILE_DIAGNOSTIC = /(?:\b(?:IO|Permission) Error:|\b(?:parquet|read_parquet|magic bytes|No files found|failed to open file|cannot open file)\b)/i;
const PRIVATE_PATH = /(?:^|[\s"'(:])(?:\/(?!\s)|[a-z]:[\\/]|\\\\|~[\\/])[^\s"')]+/i;

const AMBIGUOUS_TABLE = /^((?:Binder Error: )?)Ambiguous reference to table "([\s\S]*?)" \((?:use: |duplicate alias )[\s\S]*\)$/;
const LOCAL_QUALIFIER = /^(?:"?(?:temp|memory)"?\.)?"?main"?\./i;

/** Two relations going by one name, said with the name as a person wrote it.
 * The engine spells a local table with the catalogue and schema it lives in
 * and offers those spellings as the way out; neither means anything to the
 * person, and the way out is an alias. */
function ambiguousTable(diagnosis: string): string | null {
  const match = AMBIGUOUS_TABLE.exec(diagnosis);
  if (!match) return null;
  const name = match[2].replace(LOCAL_QUALIFIER, "").replace(/^"([\s\S]*)"$/, (_, inner: string) => inner.replace(/""/g, '"'));
  return `${match[1]}Ambiguous reference to table "${name}" (duplicate alias "${name}", explicitly alias one of the tables using "AS my_alias")`;
}

/** Only input-facing diagnosis travels. Engine suggestions and internal
 * statements are never a discovery API; artifact and native-library failures
 * do not disclose filenames, schemas, library internals or stack traces. */
export function safeEngineMessage(message: string): string {
  const quoted = stripStatementQuote(message);
  if (ABSENT_TABLE.test(quoted)) return UNKNOWN_TABLE_MESSAGE;
  const diagnosis = ambiguousTable(quoted) ?? quoted;
  if (FILE_DIAGNOSTIC.test(diagnosis)) return DATASET_READ_MESSAGE;
  const withoutSuggestions = diagnosis.split(/\n\s*(?:Did you mean\b|Candidate (?:bindings|functions)\s*:|Candidates\s*:)/i, 1)[0].trimEnd();
  if (PRIVATE_PATH.test(withoutSuggestions) || /\bInternal Error:|__dezfil_|Stack Trace:/i.test(withoutSuggestions)) return FAILED_QUERY_MESSAGE;
  return withoutSuggestions;
}

/** Refusals that must survive per-consumer fallbacks such as numeric-column
 * hints. Other conversion failures keep those consumers' existing treatment. */
export function engineRefusal(error: unknown): ApiError | null {
  if (error instanceof DatasetUnavailable) return error;
  const projection = projectionRejection(error);
  if (projection) return projection;
  if (!(error instanceof Error)) return null;
  const message = stripStatementQuote(error.message);
  return ABSENT_TABLE.test(message) || FILE_DIAGNOSTIC.test(message)
    ? new ApiError("sql_error", safeEngineMessage(message), 400) : null;
}

/** One coded failure at the evaluation boundary, including consumers that do
 * not have their own catch. Existing input positions survive only as numbers. */
export function normalizeEngineError(error: unknown): unknown {
  if (error instanceof DatasetUnavailable) return error;
  const projection = projectionRejection(error);
  if (projection) return projection;
  if (!(error instanceof Error)) return error;
  if (error instanceof ApiError ? error.code !== "sql_error" : !ENGINE_PREFIX.test(error.message)) return error;
  const position = error instanceof ApiError ? error.extra.position as Partial<SqlPosition> | undefined : undefined;
  const extra = position && Number.isInteger(position.line) && Number.isInteger(position.column) && position.line! > 0 && position.column! > 0
    ? { position: { line: position.line, column: position.column } } : {};
  return new ApiError("sql_error", safeEngineMessage(error.message), error instanceof ApiError ? error.status : 400, extra);
}

/** Convert a native failure without discarding its policy classification
 * before the diagnostic is sanitized. */
export function sqlError(error: unknown, extra: Record<string, unknown> = {}, fallback = FAILED_QUERY_MESSAGE): ApiError {
  const refusal = engineRefusal(error);
  return new ApiError(refusal?.code ?? "sql_error", refusal?.message ?? safeEngineMessage(error instanceof Error ? error.message : fallback), 400, extra);
}

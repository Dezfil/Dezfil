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

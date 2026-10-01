/**
 * SQL names: the per-account qualifier other people's SQL uses to name an
 * account's datasets (`<sql name>.<dataset>`).
 *
 * A SQL name is three to thirty-two characters: a lower-case letter first,
 * then lower-case letters, digits and underscores. It is unique on the
 * instance, never one of the reserved names below, derived once when the
 * account is created and fixed thereafter: other people's saved SQL is bound
 * to it, so no write path changes it.
 *
 * This module is loaded by the metadata migrations as well as the app, so it
 * stays dependency-free and uses only erasable TypeScript syntax.
 */

/** Every catalogue or schema name the query engine itself uses or could
 * resolve as the first part of a two-part name. The engine's in-memory
 * catalogues are `memory`, `system` and `temp`; its schemas are `main`,
 * `information_schema` and `pg_catalog`. A SQL name equal to one of them
 * would make `<sql name>.<dataset>` ambiguous with the engine's own
 * qualified names. */
export const RESERVED_SQL_NAMES: readonly string[] = [
  "main",
  "memory",
  "temp",
  "system",
  "information_schema",
  "pg_catalog",
];

/** Prefixes the engine reserves for its own catalogue functions and views
 * (`duckdb_tables`, `duckdb_databases`, ...) and for the catalogues it
 * attaches for database connections (`pg_...`). A numeric suffix cannot move
 * a name out of a reserved prefix, so a candidate that starts with one is
 * not used at all. */
export const RESERVED_SQL_NAME_PREFIXES: readonly string[] = ["duckdb", "pg_"];

/** The word a SQL name falls back to when neither the display name nor the
 * email's local part yields a usable name. */
export const SQL_NAME_FALLBACK = "user";

/** Prefixed to a candidate that would otherwise start with a digit. */
const DIGIT_PREFIX = "u";
const MIN_LENGTH = 3;
const MAX_LENGTH = 32;
const GRAMMAR = /^[a-z][a-z0-9_]{2,31}$/;

export function isReservedSqlName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_SQL_NAMES.includes(lower) ||
    RESERVED_SQL_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isValidSqlName(name: string): boolean {
  return GRAMMAR.test(name) && !isReservedSqlName(name);
}

/** One source of text turned into a candidate: accents folded, lower-cased,
 * every run of other characters joined into one underscore and dropped at
 * the edges, a letter prefixed before a leading digit, cut to the maximum
 * length. Null when the result is too short or carries a reserved prefix. */
function candidate(text: string): string | null {
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let name = words.join("_");
  if (/^[0-9]/.test(name)) name = DIGIT_PREFIX + name;
  name = name.slice(0, MAX_LENGTH).replace(/_+$/, "");
  if (name.length < MIN_LENGTH) return null;
  if (RESERVED_SQL_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  return name;
}

/** The name before collision handling: from the display name, else the
 * email's local part, else the fixed word. Always matches the grammar; it
 * may still be an exact reserved name, which allocation suffixes. */
export function baseSqlName(identity: { name: string; email: string }): string {
  const local = identity.email.split("@")[0] ?? "";
  return candidate(identity.name) ?? candidate(local) ?? SQL_NAME_FALLBACK;
}

/** Allocate a valid SQL name that `taken` does not hold: the base name, or
 * the base followed by the smallest number from 2 that is free and not
 * reserved. Always returns a valid name. */
export function allocateSqlName(
  identity: { name: string; email: string },
  taken: (name: string) => boolean,
): string {
  const base = baseSqlName(identity);
  if (!isReservedSqlName(base) && !taken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const name = base.slice(0, MAX_LENGTH - suffix.length) + suffix;
    if (isValidSqlName(name) && !taken(name)) return name;
  }
}

export interface SqlNameIdentity {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

/** Allocate names for a set of accounts at once, oldest first (then by id),
 * so the earliest account keeps the unsuffixed name. Deterministic for a
 * given set, whatever order the rows arrive in. */
export function allocateSqlNames(
  accounts: SqlNameIdentity[],
  existing: Iterable<string> = [],
): Record<string, string> {
  const taken = new Set(existing);
  const ordered = [...accounts].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const names: Record<string, string> = {};
  for (const account of ordered) {
    const name = allocateSqlName(account, (value) => taken.has(value));
    taken.add(name);
    names[account.id] = name;
  }
  return names;
}

/** The grammar and the reserved names as a SQL condition over one column,
 * for the metadata store to hold the same rule as this module. */
export function sqlNameCondition(column: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    `length(${column}) BETWEEN ${MIN_LENGTH} AND ${MAX_LENGTH}`,
    `substr(${column}, 1, 1) BETWEEN 'a' AND 'z'`,
    `${column} NOT GLOB '*[^a-z0-9_]*'`,
    `${column} NOT IN (${RESERVED_SQL_NAMES.map(quote).join(", ")})`,
    ...RESERVED_SQL_NAME_PREFIXES.map((prefix) => `${column} NOT GLOB ${quote(`${prefix}*`)}`),
  ].map((part) => `(${part})`).join(" AND ");
}

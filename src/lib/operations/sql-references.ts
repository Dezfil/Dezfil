import { classifyReference } from "@/lib/query/reference-forms";

/**
 * Where a SQL text names its tables.
 *
 * The engine's parser answers *which* tables a query reads, as a set of
 * names; it walks an AST that carries no source ranges. Duplicating a
 * workflow needs the *occurrences* — to rename an original output where it
 * is referenced and nowhere else. This scanner finds identifiers in table
 * positions: after `FROM` or a `JOIN`, and the members of a `FROM` list at
 * the list's own nesting depth, qualified or not, quoted or bare — and the
 * two dynamic forms the engine reads as tables, `query_table('name')` and
 * `query('sql')`. It leaves alone string literals elsewhere, comments,
 * other table functions, subqueries, aliases and their column lists, column
 * names, and a `WITH` name where that name is in scope (a non-recursive
 * CTE's own body reads the base table of the same name).
 *
 * It is not a parser and does not claim to be: the engine's parse of the
 * rewritten text is the check that the rewrite meant what it should, and a
 * copy whose reads do not come out as expected is refused.
 */

export interface TableReference {
  /** The identifier as written, without quotes. */
  name: string;
  /** The span of the token, quotes included when quoted. */
  start: number;
  end: number;
  /** How the name is carried: a bare or quoted identifier, or the string
   * argument of `query_table`. */
  form: "bare" | "quoted" | "string";
  /** The parts written before the name in a dotted chain (`ada` in
   * `ada.roads`, `main` in `main.roads`), without quotes. */
  qualifier?: string[];
  /** Whether an alias of its own follows the name (`roads r`, `roads AS
   * r`), which is then the name the query binds the table by. Not given for
   * a `query_table` string, which the engine never binds by its name. */
  aliased?: boolean;
}

/** How a rewrite treats a table it renames. */
export interface RewriteOptions {
  /** Keep the name the query binds a renamed table by: a reference with no
   * alias of its own takes its old name as one (`FROM roads` becomes
   * `FROM roads_2 AS roads`), so a column the query qualifies by that name
   * (`roads.geom`) still finds its table. */
  keepBoundName?: boolean;
}

/** A `query('…')` argument: SQL text carried inside a string literal, whose
 * own table references are rewritten recursively. */
interface NestedSql {
  start: number;
  end: number;
  sql: string;
}

type Token =
  | { kind: "ident"; text: string; quoted: boolean; start: number; end: number }
  | { kind: "string"; text: string; start: number; end: number }
  | { kind: "punct"; text: string; start: number; end: number };

const JOIN_KINDS = new Set(["LEFT", "RIGHT", "INNER", "FULL", "CROSS", "NATURAL", "OUTER", "SEMI", "ANTI", "ASOF", "POSITIONAL", "LATERAL"]);
/** What ends a `FROM` list: anything that cannot be another table. */
const LIST_ENDERS = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "WINDOW", "QUALIFY",
  "UNION", "EXCEPT", "INTERSECT", "ON", "USING", "JOIN", "SELECT", "WITH",
  "FETCH", "FOR", "SAMPLE",
]);

/** The words the engine's grammar never reads as a table's alias: its
 * reserved and type-function keywords (`duckdb_keywords()`). After a table's
 * name, any other word is its alias, as is a quoted identifier. */
const NOT_AN_ALIAS = new Set([
  "ALL", "ANALYSE", "ANALYZE", "AND", "ANTI", "ANY", "ARRAY", "AS", "ASC", "ASOF", "ASYMMETRIC", "AT",
  "AUTHORIZATION", "BINARY", "BOTH", "BY", "CASE", "CAST", "CHECK", "COLLATE", "COLLATION", "COLUMN",
  "COLUMNS", "CONCURRENTLY", "CONSTRAINT", "CREATE", "CROSS", "DEFAULT", "DEFERRABLE", "DESC", "DESCRIBE",
  "DISTINCT", "DO", "ELSE", "END", "EXCEPT", "FALSE", "FETCH", "FOR", "FOREIGN", "FREEZE", "FROM", "FULL",
  "GENERATED", "GLOB", "GROUP", "HAVING", "ILIKE", "IN", "INITIALLY", "INNER", "INTERSECT", "INTO", "IS",
  "ISNULL", "JOIN", "LAMBDA", "LATERAL", "LEADING", "LEFT", "LIKE", "LIMIT", "MAP", "NATURAL", "NOT",
  "NOTNULL", "NULL", "OFFSET", "ON", "ONLY", "OR", "ORDER", "OUTER", "OVERLAPS", "PIVOT", "PIVOT_LONGER",
  "PIVOT_WIDER", "PLACING", "POSITIONAL", "PRIMARY", "QUALIFY", "REFERENCES", "RETURNING", "RIGHT", "SELECT",
  "SEMI", "SHOW", "SIMILAR", "SOME", "STRUCT", "SUMMARIZE", "SYMMETRIC", "TABLE", "TABLESAMPLE", "THEN",
  "TO", "TRAILING", "TRUE", "TRY_CAST", "UNION", "UNIQUE", "UNPACK", "UNPIVOT", "USING", "VARIADIC",
  "VERBOSE", "WHEN", "WHERE", "WINDOW", "WITH",
]);

/** Whether the token after a table's name is an alias of its own. */
function aliasFollows(next: Token | undefined): boolean {
  if (!next || next.kind !== "ident") return false;
  if (next.quoted) return true;
  const word = next.text.toUpperCase();
  return word === "AS" || !NOT_AN_ALIAS.has(word);
}

/** Tokens that matter: identifiers (bare or quoted), string literals, and
 * single-character punctuation. Whitespace, comments and numbers are skipped
 * with their spans, never touched. */
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let text = "";
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { text += "'"; j += 2; continue; }
          break;
        }
        text += sql[j];
        j++;
      }
      out.push({ kind: "string", text, start: i, end: Math.min(n, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        const end = close < 0 ? n : close + m[0].length;
        out.push({ kind: "string", text: sql.slice(i + m[0].length, close < 0 ? n : close), start: i, end });
        i = end;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { text += '"'; j += 2; continue; }
          break;
        }
        text += sql[j];
        j++;
      }
      out.push({ kind: "ident", text, quoted: true, start: i, end: Math.min(n, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      out.push({ kind: "ident", text: sql.slice(i, j), quoted: false, start: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(sql[j])) j++;
      i = j;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    out.push({ kind: "punct", text: c, start: i, end: i + 1 });
    i++;
  }
  return out;
}

const upper = (t: Token | undefined) => (t && t.kind === "ident" && !t.quoted ? t.text.toUpperCase() : null);
const isPunct = (t: Token | undefined, ch: string) => !!t && t.kind === "punct" && t.text === ch;

/** The index of the `)` matching the `(` at `open`, or the last index. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], "(")) depth++;
    if (isPunct(tokens[k], ")")) { depth--; if (depth === 0) return k; }
  }
  return tokens.length - 1;
}

interface Cte {
  name: string;
  /** Token indices of its body's parentheses. */
  bodyStart: number;
  bodyEnd: number;
  recursive: boolean;
}

/** The names a WITH clause defines, each with the span of its own body: a
 * non-recursive CTE is not in scope inside itself, so `FROM x` there reads
 * the base table `x`. */
function ctes(tokens: Token[]): Cte[] {
  const out: Cte[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (upper(tokens[i]) !== "WITH") continue;
    let j = i + 1;
    const recursive = upper(tokens[j]) === "RECURSIVE";
    if (recursive) j++;
    for (;;) {
      const t = tokens[j];
      if (!t || t.kind !== "ident") break;
      let k = j + 1;
      if (isPunct(tokens[k], "(")) k = closing(tokens, k) + 1; // an optional column list
      if (upper(tokens[k]) !== "AS") break;
      k++;
      if (upper(tokens[k]) === "NOT") k++;
      if (upper(tokens[k]) === "MATERIALIZED") k++;
      if (!isPunct(tokens[k], "(")) break;
      const end = closing(tokens, k);
      out.push({ name: t.text.toLowerCase(), bodyStart: k, bodyEnd: end, recursive });
      k = end + 1;
      if (isPunct(tokens[k], ",")) { j = k + 1; continue; }
      break;
    }
  }
  return out;
}

function inScopeCte(list: Cte[], name: string, at: number): boolean {
  return list.some(
    (c) => c.name === name && (c.recursive || at < c.bodyStart || at > c.bodyEnd),
  );
}

function scan(sql: string): { refs: TableReference[]; nested: NestedSql[] } {
  const tokens = tokenize(sql);
  const cteList = ctes(tokens);
  const refs: TableReference[] = [];
  const nested: NestedSql[] = [];
  let depth = 0;
  /** The nesting depths at which a FROM list is open. */
  const open: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const word = upper(t);
    let expectTable = false;
    if (isPunct(t, "(")) { depth++; continue; }
    if (isPunct(t, ")")) { depth--; while (open.length && open[open.length - 1] > depth) open.pop(); continue; }
    if (word === "FROM") { expectTable = true; if (!open.includes(depth)) open.push(depth); }
    else if (word === "JOIN") { expectTable = true; }
    else if (isPunct(t, ",") && open.includes(depth)) { expectTable = true; }
    else if (word !== null && (LIST_ENDERS.has(word) || JOIN_KINDS.has(word))) {
      const at = open.indexOf(depth);
      if (at >= 0 && word !== "JOIN") open.splice(at, 1);
    }
    if (!expectTable) continue;

    let j = i + 1;
    const first = tokens[j];
    if (!first || first.kind !== "ident") continue; // a subquery, a file, nothing
    // a dotted chain: a.b.c — the table is the last part
    let last = first;
    const qualifier: string[] = [];
    while (isPunct(tokens[j + 1], ".") && tokens[j + 2]?.kind === "ident") {
      qualifier.push(last.text);
      j += 2;
      last = tokens[j] as Extract<Token, { kind: "ident" }>;
    }
    if (isPunct(tokens[j + 1], "(")) {
      // a table function: the two dynamic reads the engine knows are tables
      const fn = last.quoted ? null : last.text.toLowerCase();
      const arg = tokens[j + 2];
      if (fn === "query_table" && arg?.kind === "string") {
        refs.push({ name: arg.text, start: arg.start, end: arg.end, form: "string" });
      } else if (fn === "query" && arg?.kind === "string") {
        nested.push({ start: arg.start, end: arg.end, sql: arg.text });
      }
      continue;
    }
    const up = upper(last);
    if (up !== null && (LIST_ENDERS.has(up) || JOIN_KINDS.has(up))) continue;
    if (inScopeCte(cteList, last.text.toLowerCase(), i)) continue;
    refs.push({ name: last.text, start: last.start, end: last.end, form: last.quoted ? "quoted" : "bare",
      ...(qualifier.length ? { qualifier } : {}), aliased: aliasFollows(tokens[j + 1]) });
  }
  return { refs, nested };
}

/** Every table reference in the text, in source order. */
export function tableReferences(sql: string): TableReference[] {
  return scan(sql).refs;
}

/**
 * The text with every table reference `rename` answers for replaced, and
 * nothing else changed. Names compare case-insensitively, as the engine
 * reads them; a quoted reference stays quoted; a `query_table` string keeps
 * its quotes; a `query` string has its own SQL rewritten inside. With
 * `keepBoundName`, a renamed reference with no alias of its own also takes
 * its old name, as written, for one.
 */
export function rewriteTableReferences(
  sql: string,
  rename: (name: string) => string | null,
  options: RewriteOptions = {},
): string {
  const { refs, nested } = scan(sql);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const ref of refs) {
    // Only a plain name can mean the workflow's own output: `ada.roads` is
    // that person's dataset wherever it is written, and stays as written.
    if (ref.qualifier && classifyReference([...ref.qualifier, ref.name]).form !== "plain") continue;
    const next = rename(ref.name.toLowerCase());
    if (next === null) continue;
    const renamed =
      ref.form === "quoted" ? `"${next.replace(/"/g, '""')}"`
      : ref.form === "string" ? `'${next.replace(/'/g, "''")}'`
      : next;
    const bound = options.keepBoundName && ref.form !== "string" && !ref.aliased ? ` AS ${sql.slice(ref.start, ref.end)}` : "";
    edits.push({ start: ref.start, end: ref.end, text: renamed + bound });
  }
  for (const n of nested) {
    const inner = rewriteTableReferences(n.sql, rename, options);
    if (inner === n.sql) continue;
    edits.push({ start: n.start, end: n.end, text: `'${inner.replace(/'/g, "''")}'` });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += sql.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + sql.slice(cursor);
}

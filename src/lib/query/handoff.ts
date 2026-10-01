import type { DuckDBConnection } from "@duckdb/node-api";
import { ApiError } from "@/lib/api/errors";
import { NAMED_TABLE_FUNCTIONS } from "./file-policy";
import { readOnlySql } from "./guard";
import { parseSql, isSqlNode, type SqlNode } from "./sql-tree";
import { constantValue, constantValues, isCteReference } from "./references";
import { classifyReference, writtenReference } from "./reference-forms";
import { qualifiedNameParts } from "./qualified-name";
import { resolveClassified, unavailableDataset, type Namespace, type ReachableDataset } from "./bindings";
import { bindsAsRelation } from "./named-sql";

/**
 * The handoff: SQL or a named input carried from the evaluation context it
 * was written in into another one, with every dataset reference keeping the
 * dataset it meant.
 *
 * A context is a namespace (see `bindings.ts`): a SQL home, the acting
 * account's reach and, for a workflow, its declared outputs as the acting
 * account runs them. The same text can mean different datasets in two
 * contexts: `roads` in Bo's console is Bo's dataset, in a map of Ada's it is
 * Ada's. So each reference is resolved to its identity where it was written
 * and written again for where it goes:
 *
 *  - a plain name meaning a dataset of the source home stays plain when the
 *    destination's home owns that dataset and declares no output of the name,
 *    and is qualified with its owner's SQL name otherwise;
 *  - a reference that is already qualified, and the engine's own catalogues
 *    and schemas, stay as written: they mean the same everywhere;
 *  - a plain name meaning one of the source workflow's own outputs becomes
 *    the particular dataset that output is for the acting account (the
 *    output that account's latest successful run made), written for the
 *    destination; with no such output there is nothing to carry, and the
 *    handoff is refused;
 *  - a plain name that binds nothing keeps its text only where the
 *    destination would read it the same way (the same home, no output of the
 *    name) or where it is one of the engine's own relations; anywhere else it
 *    is refused, naming the reference, because it would silently start
 *    meaning someone else's dataset.
 *
 * Only the carried copy is rewritten, and only at the references that change:
 * the rest of the text, comments and layout included, is kept byte for byte.
 * Nothing stored where the text came from is touched.
 */

const MAX_NESTING = 8;

/** The refusal for a reference to a workflow output the acting account has
 * not produced: there is no particular dataset for it to stand for. */
function notProduced(written: string): ApiError {
  return new ApiError(
    "sql_error",
    `The dataset "${written}" is a workflow output you have not produced yet, so it cannot be carried over.`,
    400,
  );
}

/** The refusal for a reference the carrier cannot rewrite in place: a table
 * name computed by an expression, or SQL built at run time. */
function notCarriable(written: string): ApiError {
  return new ApiError(
    "sql_error",
    `The dataset reference "${written}" is computed, so it cannot be carried over. Name the dataset directly.`,
    400,
  );
}

/** How a dataset is named in a destination, as name parts. */
function nameFor(dataset: ReachableDataset, to: Namespace, written: string): string[] {
  if (dataset.ownerId === to.home.id && !to.outputs.has(dataset.name.toLowerCase())) return [dataset.name];
  if (dataset.ownerSqlName) return [dataset.ownerSqlName, dataset.name];
  // A store no account has adopted has no SQL names to qualify with.
  throw unavailableDataset(written);
}

/** What a reference becomes: null keeps it as written, `"relation"` keeps
 * it only when the engine knows it as one of its own relations. */
type Decision = string[] | null | "relation";

function decide(parts: readonly string[], from: Namespace, to: Namespace): Decision {
  const classified = classifyReference(parts);
  if (classified.form !== "plain") return null;
  const written = writtenReference(parts);
  const resolution = resolveClassified(from, classified);
  switch (resolution.status) {
    case "engine":
      return null;
    case "reserved":
      throw notProduced(written);
    case "unbound":
      // The destination reads the same name in the same home: nothing moves.
      if (from.home.id === to.home.id && !to.outputs.has(classified.name)) return null;
      return "relation";
    case "bound": {
      // Already the same dataset where it goes: the text stays as written.
      const there = resolveClassified(to, classified);
      if (there.status === "bound" && there.dataset.id === resolution.dataset.id) return null;
      return nameFor(resolution.dataset, to, written);
    }
  }
}

/**
 * Carry one named input (a stored dataset parameter, plain or qualified).
 * Returns the value to store in the destination; the same string when it
 * already means the same dataset there.
 */
export function carryName(value: string, from: Namespace, to: Namespace): string {
  const parts = qualifiedNameParts(value) ?? [value];
  const decision = decide(parts, from, to);
  if (decision === null) return value;
  // A named input is always a dataset, never one of the engine's relations.
  if (decision === "relation") throw unavailableDataset(writtenReference(parts));
  return writtenReference(decision);
}

interface Literal { start: number; end: number }

type Occurrence =
  | { kind: "table"; parts: string[]; start: number }
  | { kind: "column"; names: string[]; start: number }
  | { kind: "name"; value: string; literal: Literal | null }
  | { kind: "nested"; sql: string; literal: Literal | null };

const QUOTE = 0x27, DOUBLE = 0x22, DOT = 0x2e;
const isSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isWord = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x5f || byte === 0x24 || byte >= 0x80;

/** The single-quoted string literal starting at a byte offset, when its text
 * is exactly the constant the parser read there. */
function literalAt(text: Buffer, start: number | undefined, value: string): Literal | null {
  if (typeof start !== "number" || text[start] !== QUOTE) return null;
  let content = "";
  let from = start + 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== QUOTE) continue;
    content += text.subarray(from, i).toString("utf8");
    if (text[i + 1] === QUOTE) { content += "'"; i++; from = i + 1; continue; }
    return content === value ? { start, end: i + 1 } : null;
  }
  return null;
}

/** The byte span of `count` dotted identifiers starting at a byte offset,
 * when they are the parts the parser read there. */
function identifiersAt(text: Buffer, start: number, parts: readonly string[]): number | null {
  let i = start;
  for (let n = 0; n < parts.length; n++) {
    if (n > 0) {
      while (isSpace(text[i])) i++;
      if (text[i] !== DOT) return null;
      i++;
      while (isSpace(text[i])) i++;
    }
    let token: string;
    if (text[i] === DOUBLE) {
      let j = i + 1, value = "";
      let from = j;
      for (; j < text.length; j++) {
        if (text[j] !== DOUBLE) continue;
        value += text.subarray(from, j).toString("utf8");
        if (text[j + 1] === DOUBLE) { value += '"'; j++; from = j + 1; continue; }
        break;
      }
      if (j >= text.length) return null;
      token = value;
      if (token !== parts[n]) return null;
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && isWord(text[j])) j++;
      token = text.subarray(i, j).toString("utf8");
      if (!token || token.toLowerCase() !== parts[n].toLowerCase()) return null;
      i = j;
    }
  }
  return i;
}

const keyOf = (parts: readonly string[]) => JSON.stringify(parts.map((part) => part.toLowerCase()));

/** Every place a statement names a table, with where it was written. */
async function occurrences(conn: DuckDBConnection, tree: unknown, text: Buffer): Promise<Occurrence[]> {
  const out: Occurrence[] = [];
  async function walk(node: unknown, scope: ReadonlySet<string>): Promise<void> {
    if (Array.isArray(node)) { for (const child of node) await walk(child, scope); return; }
    if (!isSqlNode(node)) return;
    // The same scoping the reference walk applies: a CTE is not a dataset.
    let inner = scope;
    const cteMap = isSqlNode(node.cte_map) ? node.cte_map.map : null;
    if (Array.isArray(cteMap)) {
      const growing = new Set(scope);
      for (const entry of cteMap) {
        if (!isSqlNode(entry)) continue;
        const key = typeof entry.key === "string" ? entry.key.toLowerCase() : null;
        const definition = isSqlNode(entry.value) && isSqlNode(entry.value.query) ? entry.value.query.node : null;
        const recursive = isSqlNode(definition) && definition.type === "RECURSIVE_CTE_NODE";
        await walk(entry.value, recursive && key ? new Set([...growing, key]) : growing);
        if (key) growing.add(key);
      }
      inner = growing;
    }
    if (node.type === "BASE_TABLE" && typeof node.table_name === "string") {
      const catalog = typeof node.catalog_name === "string" ? node.catalog_name : "";
      const schema = typeof node.schema_name === "string" ? node.schema_name : "";
      if (!isCteReference(inner, catalog, schema, node.table_name) && typeof node.query_location === "number") {
        out.push({ kind: "table", parts: [catalog, schema, node.table_name].filter(Boolean), start: node.query_location });
      }
    }
    if (node.class === "COLUMN_REF" && Array.isArray(node.column_names) && node.column_names.length >= 3 && typeof node.query_location === "number") {
      out.push({ kind: "column", names: node.column_names.map(String), start: node.query_location });
    }
    if (node.type === "TABLE_FUNCTION" && isSqlNode(node.function)) {
      const fn = node.function;
      const name = typeof fn.function_name === "string" ? fn.function_name.toLowerCase() : "";
      const arg = Array.isArray(fn.children) ? fn.children[0] : undefined;
      if (arg !== undefined && NAMED_TABLE_FUNCTIONS.has(name)) {
        const constant = (expr: unknown) =>
          isSqlNode(expr) && expr.class === "CONSTANT" && isSqlNode(expr.value) && typeof expr.value.value === "string" ? expr : null;
        const items = isSqlNode(arg) && arg.class === "FUNCTION" && arg.function_name === "list_value" && Array.isArray(arg.children)
          ? arg.children : [arg];
        const literals = items.map(constant);
        if (literals.every(Boolean)) {
          for (const item of literals as SqlNode[]) {
            const value = String((item.value as SqlNode).value);
            out.push({ kind: "name", value, literal: literalAt(text, item.query_location as number, value) });
          }
        } else {
          for (const value of await constantValues(conn, arg)) out.push({ kind: "name", value, literal: null });
        }
      } else if (arg !== undefined && (name === "query" || name === "json_execute_serialized_sql")) {
        const value = await constantValue(conn, arg);
        if (value !== null && name === "query") {
          const literal = isSqlNode(arg) && arg.class === "CONSTANT" ? literalAt(text, arg.query_location as number, value) : null;
          out.push({ kind: "nested", sql: value, literal });
        } else if (value !== null) {
          // Serialized SQL is data: carried only when nothing in it moves.
          const back = await conn.runAndReadAll("SELECT json_deserialize_sql(?::JSON) AS s", [value]).catch(() => null);
          const sql = back ? String(back.getRowObjects()[0].s) : null;
          if (sql !== null) out.push({ kind: "nested", sql, literal: null });
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "cte_map") continue;
      await walk(value, inner);
    }
  }
  await walk(tree, new Set());
  return out;
}

/** A table reference's text: unquoted where the engine reads it back as
 * the same parts, quoted otherwise (a SQL name that is also a keyword). */
async function tableText(conn: DuckDBConnection, parts: readonly string[]): Promise<string> {
  const quoted = parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
  const plain = writtenReference(parts);
  if (plain === quoted) return quoted;
  const tree = await parseSql(conn, `SELECT * FROM ${plain}`).catch(() => null);
  let read: string[] | null = null;
  const find = (node: unknown) => {
    if (read || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(find); return; }
    const record = node as SqlNode;
    if (record.type === "BASE_TABLE") {
      read = [record.catalog_name, record.schema_name, record.table_name].map((part) => String(part ?? "")).filter(Boolean);
      return;
    }
    Object.values(record).forEach(find);
  };
  if (tree && !tree.error) find(tree.statements);
  const same = read !== null && keyOf(read) === keyOf(parts);
  return same ? plain : quoted;
}

const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Carry a statement from one context into another. The statement must pass
 * the read-only guard where it was written. Returns the text to store in the
 * destination: the very same string when nothing in it moves.
 */
export async function carrySql(conn: DuckDBConnection, sql: string, from: Namespace, to: Namespace, depth = 0): Promise<string> {
  if (depth === 0) await readOnlySql(conn, sql);
  if (depth > MAX_NESTING) throw notCarriable("query");
  const tree = await parseSql(conn, sql);
  if (tree.error) throw notCarriable("query");
  const text = Buffer.from(sql, "utf8");
  const found = await occurrences(conn, tree.statements, text);
  const edits: { start: number; end: number; text: string }[] = [];
  const renamed = new Map<string, string>();

  const decided = async (parts: readonly string[]): Promise<string[] | null> => {
    const decision = decide(parts, from, to);
    if (decision !== "relation") return decision;
    if (await bindsAsRelation(conn, parts)) return null;
    throw unavailableDataset(writtenReference(parts));
  };

  for (const occurrence of found) {
    if (occurrence.kind === "table") {
      const target = await decided(occurrence.parts);
      if (target === null) continue;
      const end = identifiersAt(text, occurrence.start, occurrence.parts);
      if (end === null) throw notCarriable(writtenReference(occurrence.parts));
      const replacement = await tableText(conn, target);
      edits.push({ start: occurrence.start, end, text: replacement });
      if (occurrence.parts.length > 1) renamed.set(keyOf(occurrence.parts), replacement);
    } else if (occurrence.kind === "name") {
      const parts = qualifiedNameParts(occurrence.value) ?? [occurrence.value];
      const target = await decided(parts);
      if (target === null) continue;
      if (!occurrence.literal) throw notCarriable(occurrence.value);
      edits.push({ ...occurrence.literal, text: quoteLiteral(writtenReference(target)) });
    } else if (occurrence.kind === "nested") {
      const carried = await carrySql(conn, occurrence.sql, from, to, depth + 1);
      if (carried === occurrence.sql) continue;
      if (!occurrence.literal) throw notCarriable("query");
      edits.push({ ...occurrence.literal, text: quoteLiteral(carried) });
    }
  }
  // A column qualified by a rewritten engine-qualified table (`main.roads.x`
  // beside `FROM main.roads`) follows its table.
  for (const occurrence of found) {
    if (occurrence.kind !== "column") continue;
    for (const length of [3, 2]) {
      const replacement = occurrence.names.length > length ? renamed.get(keyOf(occurrence.names.slice(0, length))) : undefined;
      if (replacement === undefined) continue;
      const end = identifiersAt(text, occurrence.start, occurrence.names.slice(0, length));
      if (end === null) throw notCarriable(writtenReference(occurrence.names.slice(0, length)));
      edits.push({ start: occurrence.start, end, text: replacement });
      break;
    }
  }
  if (edits.length === 0) return sql;
  edits.sort((a, b) => b.start - a.start);
  let result = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of edits) {
    // Two rewrites of one place would leave one of them unapplied.
    if (edit.end > floor) throw notCarriable("query");
    result = Buffer.concat([result.subarray(0, edit.start), Buffer.from(edit.text, "utf8"), result.subarray(edit.end)]);
    floor = edit.start;
  }
  return result.toString("utf8");
}

/** The definition parts of a workflow step that name datasets. */
export interface CarriedDefinition {
  /** The parameters that hold a dataset name. */
  inputs: readonly { name: string }[];
  /** True when the operation takes SQL in `sql`. */
  takesSql: boolean;
}

/**
 * Carry a step's parameters: every declared dataset input and its SQL. A new
 * object is returned; the parameters given are not changed.
 */
export async function carryParameters(
  conn: DuckDBConnection,
  definition: CarriedDefinition,
  parameters: Record<string, unknown>,
  from: Namespace,
  to: Namespace,
): Promise<Record<string, unknown>> {
  const carried = { ...parameters };
  for (const input of definition.inputs) {
    const value = carried[input.name];
    if (typeof value === "string" && value !== "") carried[input.name] = carryName(value, from, to);
  }
  if (definition.takesSql && typeof carried.sql === "string" && carried.sql.trim() !== "") {
    carried.sql = await carrySql(conn, carried.sql, from, to);
  }
  return carried;
}

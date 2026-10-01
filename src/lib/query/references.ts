import type { DuckDBConnection } from "@duckdb/node-api";
import { NAMED_TABLE_FUNCTIONS } from "./file-policy";
import { parseSqlJson } from "./sql-json";
import { qualifiedNameParts } from "./qualified-name";

/**
 * The table references a statement makes, read from the engine's own parse.
 *
 * A common-table-expression reference is indistinguishable from a real table
 * at the leaf (both serialize as BASE_TABLE), so the walk carries the CTE names
 * in scope and leaves out references that resolve to one. A table can also be
 * named by a string: the dynamic table-reading and query-executing functions
 * take a constant expression naming a table or carrying SQL, and the reference
 * then lives inside a function argument. Those are resolved by evaluating the
 * argument, which is always possible because the binder refuses a subquery or
 * a column parameter there.
 *
 * Every reference keeps its qualification exactly as written. Which dataset a
 * qualified name means is the binding resolver's question, never this walk's:
 * dropping the qualifier here would make `ada.roads` and `roads` the same read.
 */

const CARRIES_SQL = new Set(["query"]);

/** One table reference, its name's parts in the case they were written. */
export interface TableReference {
  /** `["roads"]`, `["ada", "roads"]`, `["memory", "main", "roads"]`. */
  parts: string[];
  /** Named by a string argument rather than in a FROM clause. */
  dynamic: boolean;
}

export interface ReferenceCollection {
  /** Each distinct reference once, in the order the walk first met it. */
  references: TableReference[];
  /** A lower-cased alias, or implicit name, to the reference it denotes. */
  aliases: Map<string, TableReference>;
  /** Every column reference, lower-cased parts. */
  columnRefs: string[][];
  /** True when any star projection appears. */
  starScopes: boolean;
}

interface Serialized {
  error: boolean;
  error_message?: string;
  statements?: unknown[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export async function serializeSql(conn: DuckDBConnection, sql: string): Promise<Serialized> {
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql(?::VARCHAR) AS j", [sql]);
  return parseSqlJson(String(reader.getRowObjects()[0].j)) as unknown as Serialized;
}

/** Round-trip an expression node back to SQL text through the engine. */
async function deserialize(conn: DuckDBConnection, expr: unknown): Promise<string | null> {
  const synthetic = {
    error: false,
    statements: [{
      node: {
        type: "SELECT_NODE", modifiers: [], cte_map: { map: [] }, select_list: [expr],
        from_table: { type: "EMPTY", alias: "", sample: null, query_location: 0 },
        where_clause: null, group_expressions: [], group_sets: [],
        aggregate_handling: "STANDARD_HANDLING", having: null, sample: null, qualify: null,
      },
      named_param_map: [],
    }],
  };
  try {
    const back = await conn.runAndReadAll("SELECT json_deserialize_sql(?::JSON) AS s", [JSON.stringify(synthetic)]);
    return String(back.getRowObjects()[0].s);
  } catch {
    return null;
  }
}

/** A constant expression's string value. A plain constant short-circuits;
 * anything else is round-tripped through the engine and evaluated. */
async function constantValue(conn: DuckDBConnection, expr: unknown): Promise<string | null> {
  if (!isRecord(expr)) return null;
  if (expr.class === "CONSTANT") {
    const value = isRecord(expr.value) ? expr.value.value : null;
    return typeof value === "string" ? value : null;
  }
  const text = await deserialize(conn, expr);
  if (!text) return null;
  try {
    const row = (await conn.runAndReadAll(text)).getRowObjects()[0];
    const only = row ? Object.values(row)[0] : null;
    return typeof only === "string" ? only : null;
  } catch {
    return null;
  }
}

async function constantList(conn: DuckDBConnection, expr: unknown): Promise<string[]> {
  if (!isRecord(expr)) return [];
  const text = await deserialize(conn, expr);
  if (!text) return [];
  try {
    const value = await conn.runAndReadAll(`SELECT unnest(x) AS v FROM (${text} ) t(x)`);
    return value.getRowObjects().map((r) => (typeof r.v === "string" ? r.v : null)).filter((v): v is string => v !== null);
  } catch {
    return [];
  }
}

/** The argument's value(s): one name, or every name in a list. */
async function constantValues(conn: DuckDBConnection, expr: unknown): Promise<string[]> {
  const single = await constantValue(conn, expr);
  return single !== null ? [single] : constantList(conn, expr);
}

const keyOf = (parts: readonly string[]) => JSON.stringify(parts.map((part) => part.toLowerCase()));

/** Whether a FROM-clause name denotes a CTE in scope rather than a table. */
export function isCteReference(ctes: ReadonlySet<string>, catalog: string, schema: string, table: string): boolean {
  const name = table.toLowerCase();
  if (!catalog && !schema) return ctes.has(name);
  return !catalog && schema.toLowerCase() === "recurring" && ctes.has(name);
}

/**
 * Walk a serialized node, carrying the CTE names in scope. Recursion is
 * structural: anything not recognised is descended into, so a shape this
 * version has not met cannot hide a table reference from the walk.
 */
async function walk(
  conn: DuckDBConnection,
  node: unknown,
  scope: ReadonlySet<string>,
  out: ReferenceCollection,
  seen: Map<string, TableReference>,
): Promise<void> {
  if (Array.isArray(node)) {
    for (const child of node) await walk(conn, child, scope, out, seen);
    return;
  }
  if (!isRecord(node)) return;
  const record = (parts: string[], dynamic: boolean): TableReference => {
    const key = keyOf(parts);
    let reference = seen.get(key);
    if (!reference) {
      reference = { parts, dynamic };
      seen.set(key, reference);
      out.references.push(reference);
    }
    return reference;
  };

  // A SELECT node introduces its CTE names. Definitions are walked under the
  // scope built so far, so a later CTE may reference an earlier one while a
  // first CTE naming a real table still records it. A recursive CTE refers to
  // itself inside its own definition; the engine marks one by its node type.
  let inner = scope;
  const cteMap = isRecord(node.cte_map) ? node.cte_map.map : null;
  if (Array.isArray(cteMap)) {
    const growing = new Set(scope);
    for (const entry of cteMap) {
      if (!isRecord(entry)) continue;
      const key = typeof entry.key === "string" ? entry.key.toLowerCase() : null;
      const definition = isRecord(entry.value) && isRecord(entry.value.query) ? entry.value.query.node : null;
      const recursive = isRecord(definition) && definition.type === "RECURSIVE_CTE_NODE";
      await walk(conn, entry.value, recursive && key ? new Set([...growing, key]) : growing, out, seen);
      if (key) growing.add(key);
    }
    inner = growing;
  }

  if (node.type === "BASE_TABLE" && typeof node.table_name === "string") {
    const catalog = typeof node.catalog_name === "string" ? node.catalog_name : "";
    const schema = typeof node.schema_name === "string" ? node.schema_name : "";
    // A CTE reference is not an input. Schema- or catalog-qualified names
    // cannot be a CTE, so they are always a real reference, except the
    // engine's own `recurring.<cte>`: a keyed recursive CTE's recurring table.
    if (!isCteReference(inner, catalog, schema, node.table_name)) {
      const reference = record([catalog, schema, node.table_name].filter(Boolean), false);
      const alias = typeof node.alias === "string" && node.alias !== "" ? node.alias : node.table_name;
      out.aliases.set(alias.toLowerCase(), reference);
    }
  }

  if (node.type === "TABLE_FUNCTION" && isRecord(node.function)) {
    const fn = node.function;
    const fnName = typeof fn.function_name === "string" ? fn.function_name.toLowerCase() : "";
    const args = Array.isArray(fn.children) ? fn.children : [];
    if (NAMED_TABLE_FUNCTIONS.has(fnName) && args.length > 0) {
      // One table or a list of them: a list-valued call reads every one.
      const named = await constantValues(conn, args[0]);
      const alias = typeof node.alias === "string" && node.alias !== "" ? node.alias.toLowerCase() : null;
      for (const one of named) {
        const parts = qualifiedNameParts(one) ?? [one];
        const reference = record(parts, true);
        out.aliases.set(parts.at(-1)!.toLowerCase(), reference);
        // `FROM query_table('assumed') AS q` puts the alias on the function
        // node; a later `q.geom` must still find its table. Only meaningful
        // when the call names exactly one table.
        if (alias && named.length === 1) out.aliases.set(alias, reference);
      }
    } else if (CARRIES_SQL.has(fnName) && args.length > 0) {
      const nested = await constantValue(conn, args[0]);
      if (nested) {
        const parsed = await serializeSql(conn, nested);
        // The carried SQL is a query in its own right: same walk, fresh
        // scope, because its CTEs are its own.
        if (!parsed.error && Array.isArray(parsed.statements)) await walk(conn, parsed.statements, new Set(), out, seen);
      }
    }
  }

  if (node.class === "COLUMN_REF" && Array.isArray(node.column_names)) {
    out.columnRefs.push(node.column_names.map((c) => String(c).toLowerCase()));
  }
  if (node.class === "STAR" || node.type === "STAR") out.starScopes = true;

  for (const [key, value] of Object.entries(node)) {
    if (key === "cte_map") continue; // already walked, under the right scope
    await walk(conn, value, inner, out, seen);
  }
}

/** The references of serialized statements, in walk order. */
export async function collectReferences(conn: DuckDBConnection, statements: unknown[]): Promise<ReferenceCollection> {
  const out: ReferenceCollection = { references: [], aliases: new Map(), columnRefs: [], starScopes: false };
  await walk(conn, statements, new Set(), out, new Map());
  return out;
}

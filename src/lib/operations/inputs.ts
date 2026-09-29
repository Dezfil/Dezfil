import { parseSqlJson } from "@/lib/query/sql-json";
import { qualifiedNameParts } from "@/lib/query/qualified-name";
import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Which registered tables a query actually reads.
 *
 * The recorded input set is the edge staleness rides on, so it has to be exact
 * rather than approximately right, and it cannot be repaired later: provenance
 * is written when a run happens, and records already minted would stay wrong.
 * That rules out the existing dependency scanner, which matches known table
 * names against SQL text and deliberately over-matches — the cheap error for a
 * tile rebuild, the expensive one for a user-visible badge.
 *
 * Instead this asks the engine's own parser, the way the read-only guard does,
 * and walks the serialized statement. Two things make that correct rather than
 * nearly correct, and both were established by probing the pinned engine:
 *
 *  1. A common-table-expression reference is indistinguishable from a real
 *     table at the leaf — both serialize as BASE_TABLE. So the walk carries a
 *     scope of CTE names and excludes references that resolve to one.
 *  2. A table can be named by a *string*: the dynamic table-reading and
 *     query-executing functions take a constant expression naming a table or
 *     carrying SQL, and the reference then lives inside a function argument
 *     where no BASE_TABLE node ever appears. Those are resolved by evaluating
 *     the argument, which is always possible because the binder refuses a
 *     subquery or a column parameter there.
 */

/** Dynamic table functions whose argument names a table, or carries SQL. */
const NAMES_A_TABLE = new Set(["query_table"]);
const CARRIES_SQL = new Set(["query"]);

export interface QueryInputs {
  /** Registered table names the query reads, lower-cased, de-duplicated. */
  tables: string[];
  /** Of those, the ones whose geometry the query references. */
  geometryTables: string[];
}

interface Serialized {
  error: boolean;
  error_message?: string;
  statements?: unknown[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function serialize(
  conn: DuckDBConnection,
  sql: string,
): Promise<Serialized> {
  const reader = await conn.runAndReadAll(
    "SELECT json_serialize_sql(?::VARCHAR) AS j",
    [sql],
  );
  return parseSqlJson(String(reader.getRowObjects()[0].j)) as unknown as Serialized;
}

/**
 * Evaluate a constant expression node to its string value. Safe by
 * construction: the binder refuses a subquery or a column parameter in these
 * arguments, so the expression can only fold to a constant. A plain constant
 * short-circuits; anything else is round-tripped back to SQL through the
 * engine and evaluated, which covers concatenations and the like.
 */
async function constantValue(
  conn: DuckDBConnection,
  expr: unknown,
): Promise<string | null> {
  if (!isRecord(expr)) return null;
  if (expr.class === "CONSTANT") {
    const value = isRecord(expr.value) ? expr.value.value : null;
    return typeof value === "string" ? value : null;
  }
  const text = await deserialize(conn, expr);
  if (!text) return null;
  try {
    const value = await conn.runAndReadAll(text);
    const row = value.getRowObjects()[0];
    const only = row ? Object.values(row)[0] : null;
    return typeof only === "string" ? only : null;
  } catch {
    return null;
  }
}

/** Round-trip an expression node back to SQL text through the engine. */
async function deserialize(
  conn: DuckDBConnection,
  expr: unknown,
): Promise<string | null> {
  const synthetic = {
    error: false,
    statements: [
      {
        node: {
          type: "SELECT_NODE",
          modifiers: [],
          cte_map: { map: [] },
          select_list: [expr],
          from_table: {
            type: "EMPTY",
            alias: "",
            sample: null,
            query_location: 0,
          },
          where_clause: null,
          group_expressions: [],
          group_sets: [],
          aggregate_handling: "STANDARD_HANDLING",
          having: null,
          sample: null,
          qualify: null,
        },
        named_param_map: [],
      },
    ],
  };
  try {
    const back = await conn.runAndReadAll(
      "SELECT json_deserialize_sql(?::JSON) AS s",
      [JSON.stringify(synthetic)],
    );
    return String(back.getRowObjects()[0].s);
  } catch {
    return null;
  }
}

/** The argument's value(s): one name, or every name in a list. */
async function constantValues(
  conn: DuckDBConnection,
  expr: unknown,
): Promise<string[]> {
  const single = await constantValue(conn, expr);
  if (single !== null) return [single];
  const list = await constantList(conn, expr);
  return list;
}

async function constantList(
  conn: DuckDBConnection,
  expr: unknown,
): Promise<string[]> {
  if (!isRecord(expr)) return [];
  const text = await deserialize(conn, expr);
  if (!text) return [];
  try {
    const value = await conn.runAndReadAll(
      `SELECT unnest(x) AS v FROM (${text.replace(/^SELECT /, "SELECT ")} ) t(x)`,
    );
    return value
      .getRowObjects()
      .map((r) => (typeof r.v === "string" ? r.v : null))
      .filter((v): v is string => v !== null);
  } catch {
    return [];
  }
}

interface Collector {
  tables: Set<string>;
  /** Table names, and aliases bound to them, whose geometry is referenced. */
  aliases: Map<string, string>;
  columnRefs: string[][];
  starScopes: boolean;
}

/**
 * Walk a serialized node, carrying the set of CTE names in scope. Recursion is
 * structural: anything not recognised is descended into, so a shape this
 * version has not met cannot hide a table reference from the walk.
 */
async function walk(
  conn: DuckDBConnection,
  node: unknown,
  scope: ReadonlySet<string>,
  out: Collector,
): Promise<void> {
  if (Array.isArray(node)) {
    for (const child of node) await walk(conn, child, scope, out);
    return;
  }
  if (!isRecord(node)) return;

  // A SELECT node introduces its CTE names. Definitions are walked under the
  // scope built so far, so a later CTE may reference an earlier one while a
  // first CTE naming a real table still records it.
  let inner = scope;
  const cteMap = isRecord(node.cte_map) ? node.cte_map.map : null;
  if (Array.isArray(cteMap)) {
    const growing = new Set(scope);
    for (const entry of cteMap) {
      if (!isRecord(entry)) continue;
      const key = typeof entry.key === "string" ? entry.key.toLowerCase() : null;
      // A recursive CTE refers to itself inside its own definition, so its
      // name is in scope while that definition is walked. A non-recursive one
      // is not: `WITH stations AS (SELECT … FROM stations)` reads the real
      // table, and treating that as a self-reference would lose a genuine
      // input. The engine records which it is.
      // The engine marks it in the node's own type, not in the CTE entry:
      // a recursive definition is a RECURSIVE_CTE_NODE.
      const definition =
        isRecord(entry.value) && isRecord(entry.value.query)
          ? entry.value.query.node
          : null;
      const recursive =
        isRecord(definition) && definition.type === "RECURSIVE_CTE_NODE";
      const definitionScope =
        recursive && key ? new Set([...growing, key]) : growing;
      await walk(conn, entry.value, definitionScope, out);
      if (key) growing.add(key);
    }
    inner = growing;
  }

  if (node.type === "BASE_TABLE" && typeof node.table_name === "string") {
    const name = node.table_name.toLowerCase();
    // A CTE reference is not an input. Schema- or catalog-qualified names
    // cannot be a CTE, so they are always a real reference.
    const qualified =
      (typeof node.schema_name === "string" && node.schema_name !== "") ||
      (typeof node.catalog_name === "string" && node.catalog_name !== "");
    if (qualified || !inner.has(name)) {
      out.tables.add(name);
      const alias =
        typeof node.alias === "string" && node.alias !== ""
          ? node.alias.toLowerCase()
          : name;
      out.aliases.set(alias, name);
    }
  }

  if (node.type === "TABLE_FUNCTION" && isRecord(node.function)) {
    const fn = node.function;
    const fnName =
      typeof fn.function_name === "string"
        ? fn.function_name.toLowerCase()
        : "";
    const args = Array.isArray(fn.children) ? fn.children : [];
    if (NAMES_A_TABLE.has(fnName) && args.length > 0) {
      // The argument may name one table or a list of them; a list-valued call
      // reads every table in it, and taking only the string form would record
      // none of them.
      const named = await constantValues(conn, args[0]);
      const alias =
        typeof node.alias === "string" && node.alias !== ""
          ? node.alias.toLowerCase()
          : null;
      for (const one of named) {
        const bare = (qualifiedNameParts(one)?.at(-1) ?? one).toLowerCase();
        out.tables.add(bare);
        out.aliases.set(bare, bare);
        // `FROM query_table('assumed') AS q` puts the alias on the function
        // node. Without it a later `q.geom` resolves to nothing and the
        // input's assumed-CRS flag is silently dropped — under-warning, which
        // is the direction the ruling does not permit. Only meaningful when
        // the call names exactly one table.
        if (alias && named.length === 1) out.aliases.set(alias, bare);
      }
    } else if (CARRIES_SQL.has(fnName) && args.length > 0) {
      const nested = await constantValue(conn, args[0]);
      if (nested) {
        const parsed = await serialize(conn, nested);
        if (!parsed.error && Array.isArray(parsed.statements)) {
          // The carried SQL is a query in its own right — same walk, fresh
          // scope, because its CTEs are its own.
          await walk(conn, parsed.statements, new Set(), out);
        }
      }
    }
  }

  if (node.class === "COLUMN_REF" && Array.isArray(node.column_names)) {
    out.columnRefs.push(node.column_names.map((c) => String(c).toLowerCase()));
  }
  if (node.class === "STAR" || node.type === "STAR") out.starScopes = true;

  for (const [key, value] of Object.entries(node)) {
    if (key === "cte_map") continue; // already walked, under the right scope
    await walk(conn, value, inner, out);
  }
}

/**
 * The tables a query reads, and which of their geometries it references.
 *
 * `geometryOf` supplies each registered table's geometry column; a table with
 * none can never contribute geometry. The geometry answer decides whether a
 * derived dataset inherits an input's assumed-CRS flag, and it errs toward
 * *yes*: a star projection is treated as carrying every input's geometry, and
 * an unresolvable reference counts as a reference. Over-warning is the
 * direction the gate accepted; silently under-warning would make a derived
 * dataset look more certain than the data it came from.
 */
export async function queryInputs(
  conn: DuckDBConnection,
  sql: string,
  geometryOf: (table: string) => string | null,
): Promise<QueryInputs> {
  const parsed = await serialize(conn, sql);
  if (parsed.error || !Array.isArray(parsed.statements)) {
    return { tables: [], geometryTables: [] };
  }
  return collectInputs(conn, parsed.statements, geometryOf);
}

/** The strict sibling: a statement that cannot be analyzed
 * is a FAILURE, never an empty read. The tolerant behavior above is
 * the workflow reads' shipped contract and stays exactly as it is. */
export async function queryInputsStrict(
  conn: DuckDBConnection,
  sql: string,
  geometryOf: (table: string) => string | null,
): Promise<QueryInputs> {
  const parsed = await serialize(conn, sql);
  if (parsed.error || !Array.isArray(parsed.statements)) {
    throw new Error(
      typeof parsed.error_message === "string" && parsed.error_message
        ? parsed.error_message
        : "The statement could not be analyzed.",
    );
  }
  return collectInputs(conn, parsed.statements, geometryOf);
}

async function collectInputs(
  conn: DuckDBConnection,
  statements: unknown[],
  geometryOf: (table: string) => string | null,
): Promise<QueryInputs> {
  const out: Collector = {
    tables: new Set(),
    aliases: new Map(),
    columnRefs: [],
    starScopes: false,
  };
  await walk(conn, statements, new Set(), out);

  const tables = [...out.tables].sort();
  const geometryTables = tables.filter((table) => {
    const geom = geometryOf(table)?.toLowerCase();
    if (!geom) return false;
    // A star projection carries whatever the table has, geometry included.
    if (out.starScopes) return true;
    return out.columnRefs.some((ref) => {
      const column = ref[ref.length - 1];
      if (column !== geom) return false;
      if (ref.length === 1) return true; // unqualified — attribute to any input
      const owner = out.aliases.get(ref[ref.length - 2]);
      return owner === table;
    });
  });
  return { tables, geometryTables };
}

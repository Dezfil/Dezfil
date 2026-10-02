import { readOnlySql } from "@/lib/query/guard";
import { collectReferences, serializeSql, type TableReference } from "@/lib/query/references";
import { classifyReference, writtenReference } from "@/lib/query/reference-forms";
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

export interface QueryInputs {
  /** Registered table names the query reads, lower-cased, de-duplicated. A
   * name qualified by a person's SQL name is not among them: it names that
   * person's dataset, never a plain name's binding (see `external`). */
  tables: string[];
  /** Of those, the ones whose geometry the query references. */
  geometryTables: string[];
  /** The qualified references to other people's datasets, as written. */
  external: string[];
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
  const parsed = await serializeSql(conn, sql);
  if (parsed.error || !Array.isArray(parsed.statements)) {
    return { tables: [], geometryTables: [], external: [] };
  }
  const admitted = await serializeSql(conn, await readOnlySql(conn, sql));
  return collectInputs(conn, admitted.statements!, geometryOf);
}

/** The strict sibling: a statement that cannot be analyzed
 * is a FAILURE, never an empty read. The tolerant behavior above is
 * the workflow reads' shipped contract and stays exactly as it is. */
export async function queryInputsStrict(
  conn: DuckDBConnection,
  sql: string,
  geometryOf: (table: string) => string | null,
): Promise<QueryInputs> {
  const parsed = await serializeSql(conn, sql);
  if (parsed.error || !Array.isArray(parsed.statements)) {
    throw new Error(
      typeof parsed.error_message === "string" && parsed.error_message
        ? parsed.error_message
        : "The statement could not be analyzed.",
    );
  }
  const admitted = await serializeSql(conn, await readOnlySql(conn, sql));
  return collectInputs(conn, admitted.statements!, geometryOf);
}

async function collectInputs(
  conn: DuckDBConnection,
  statements: unknown[],
  geometryOf: (table: string) => string | null,
): Promise<QueryInputs> {
  const collected = await collectReferences(conn, statements);
  const plain = new Set<string>();
  const external: string[] = [];
  const nameOf = new Map<TableReference, string>();
  for (const reference of collected.references) {
    const classified = classifyReference(reference.parts);
    if (classified.form === "qualified") { external.push(writtenReference(reference.parts)); continue; }
    // The engine's own forms read as their last part, as they always have.
    const name = classified.form === "plain" ? classified.name : reference.parts.at(-1)!.toLowerCase();
    plain.add(name);
    nameOf.set(reference, name);
  }
  const tables = [...plain].sort();
  const geometryTables = tables.filter((table) => {
    const geom = geometryOf(table)?.toLowerCase();
    if (!geom) return false;
    // A star projection carries whatever the table has, geometry included.
    if (collected.starScopes) return true;
    return collected.columnRefs.some((ref) => {
      const column = ref[ref.length - 1];
      if (column !== geom) return false;
      if (ref.length === 1) return true; // unqualified — attribute to any input
      const owner = collected.aliases.get(ref[ref.length - 2]);
      return owner !== undefined && nameOf.get(owner) === table;
    });
  });
  return { tables, geometryTables, external };
}

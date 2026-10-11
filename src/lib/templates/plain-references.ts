import type { DuckDBConnection } from "@duckdb/node-api";
import { queryInputsStrict } from "@/lib/operations/inputs";
import { tableReferences } from "@/lib/operations/sql-references";
import { readOnlySql } from "@/lib/query/guard";
import { classifyReference } from "@/lib/query/reference-forms";
import { collectReferences, serializeSql, type ReferenceCollection } from "@/lib/query/references";

/**
 * A template's SQL names its own datasets and results as plain table
 * references only.
 *
 * A copy lands a dataset under the next free name when its own is taken and
 * rewrites each place the SQL names it as a table (copy-references.ts). A
 * name the rewrite cannot reach (a table function's argument, listed or
 * computed, SQL carried inside a string, a string in a table's place) would
 * outlive the rename and read another dataset of the copier's, or nothing.
 * Nor does a schema on the name (`main.stations`) or on a column's
 * qualifier (`main.stations.geom`) survive it: a renamed table keeps its old
 * name only as an alias (`FROM stations_2 AS stations`), which a column
 * qualified by a schema does not find. So a template never names one of its
 * own either way; templates are authored for the product, and the rule
 * costs their SQL nothing.
 *
 * The engine's parse holds the rule, not a reading of the text: no table or
 * column qualifier it finds spells a member with a schema, and once every
 * name the rewrite would reach is replaced by one no member carries, the
 * parse of what is left reads none of the template's members.
 */

/** The text with each name the copy's rewrite reaches in a table's place
 * replaced by a name no member carries; strings and table functions' arguments
 * stay as they are. */
function withoutPlainReferences(sql: string, members: ReadonlySet<string>): string {
  let out = "";
  let cursor = 0;
  let count = 0;
  const free = () => {
    let name = `plain_reference_${count++}`;
    while (members.has(name)) name += "_";
    return name;
  };
  for (const ref of tableReferences(sql)) {
    if (ref.form === "string" || !members.has(ref.name.toLowerCase())) continue;
    // A qualified name is the template's own only when it is a spelling of
    // its plain name, which is what the rewrite reaches.
    if (ref.qualifier && classifyReference([...ref.qualifier, ref.name]).form !== "plain") continue;
    const name = free();
    out += sql.slice(cursor, ref.start) + (ref.form === "quoted" ? `"${name}"` : name);
    cursor = ref.end;
  }
  return out + sql.slice(cursor);
}

/** The first member the parse finds qualified by a schema, as a table
 * (`main.stations`) or in a column's qualifier (`main.stations.geom`, the
 * column's first two or three parts), or null. */
function schemaQualified(collected: ReferenceCollection, members: ReadonlySet<string>): string | null {
  for (const { parts, dynamic } of collected.references) {
    if (dynamic || parts.length === 1) continue;
    const classified = classifyReference(parts);
    if (classified.form === "plain" && members.has(classified.name)) return classified.name;
  }
  for (const column of collected.columnRefs) {
    for (let k = 2; k < column.length && k <= 3; k++) {
      const classified = classifyReference(column.slice(0, k));
      if (classified.form === "plain" && members.has(classified.name)) return classified.name;
    }
  }
  return null;
}

const PLAIN_ONLY = "a template's SQL names its own datasets and results as plain table references only.";

/**
 * The refusal for a text that names one of the template's members (its
 * datasets and its steps' results, lower-cased) other than as a plain table
 * reference, worded for `where`, or null.
 */
export async function plainReferenceProblem(
  conn: DuckDBConnection,
  sql: string,
  members: ReadonlySet<string>,
  where: string,
): Promise<string | null> {
  const parsed = await serializeSql(conn, await readOnlySql(conn, sql));
  const qualified = schemaQualified(await collectReferences(conn, parsed.statements ?? []), members);
  if (qualified !== null) return `${where} qualifies "${qualified}" by a schema; ${PLAIN_ONLY}`;
  const { tables } = await queryInputsStrict(conn, withoutPlainReferences(sql, members), () => null);
  const left = tables.find((name) => members.has(name));
  return left === undefined ? null : `${where} names "${left}" inside a string or a table function's argument; ${PLAIN_ONLY}`;
}

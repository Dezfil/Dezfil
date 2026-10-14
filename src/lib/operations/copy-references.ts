import { ApiError } from "@/lib/api/errors";
import type { DatasetScope } from "@/lib/query/access";
import { queryInputsStrict } from "./inputs";
import { rewriteTableReferences } from "./sql-references";
import { boundedEvaluation, isBoundedOutcome } from "@/lib/query/bounded";
import { readOnlySql } from "@/lib/query/guard";
import { classifyReference } from "@/lib/query/reference-forms";
import { collectReferences, serializeSql } from "@/lib/query/references";

/** A table a text names in a FROM clause: the name it reads it under, as
 * `tables` gives it, whether that is a plain name, and the alias written
 * for it. */
interface Binding {
  table: string;
  plain: boolean;
  alias: string | null;
}

/** What a text reads, by the engine's parse: the tables, the references
 * to other people's datasets, each name it binds a table by (an alias, or
 * the table's own name), to that table, each table a FROM clause names, and
 * its columns, lower-cased parts. */
export interface CopyReads {
  tables: string[];
  external: string[];
  bound: Map<string, string>;
  bindings: Binding[];
  columns: string[][];
}

/** Whether a column's qualifier names a table the text binds, as the
 * engine binds it: an aliased table by its alias alone, any other by its
 * name or a spelling of it with its schema or catalogue
 * (`main.stations`, `temp.main.stations`). */
function qualifies(qualifier: readonly string[], binding: Binding): boolean {
  if (binding.alias !== null) return qualifier.length === 1 && qualifier[0] === binding.alias;
  if (!binding.plain) return qualifier.length === 1 && qualifier[0] === binding.table;
  const classified = classifyReference(qualifier);
  return classified.form === "plain" && classified.name === binding.table;
}

/** Every column a text qualifies by a table finds the table it found in
 * the original text, as landed, read as each spelling the engine could
 * take it for: its first one, two or three parts naming a table, the whole
 * column among them, since a column of a table's name alone is its row
 * (`stations`, `main.stations`). */
function columnsAgree(original: CopyReads, rewritten: CopyReads, as: (table: string) => string): boolean {
  const named = (reads: CopyReads, qualifier: string[], to: (table: string) => string) =>
    [...new Set(reads.bindings.filter((b) => qualifies(qualifier, b)).map((b) => to(b.table)))].sort().join("\n");
  return [...original.columns, ...rewritten.columns].every((column) => {
    for (let parts = 1; parts <= column.length && parts <= 3; parts++) {
      const qualifier = column.slice(0, parts);
      if (named(original, qualifier, as) !== named(rewritten, qualifier, (table) => table)) return false;
    }
    return true;
  });
}

/** The rewrite of a text, every renamed table keeping the name the text
 * binds it by. */
export const rewriteCopySql = (sql: string, landed: ReadonlyMap<string, string>) =>
  rewriteTableReferences(sql, (name) => {
    const to = landed.get(name);
    return to === undefined || to === name ? null : to;
  }, { keepBoundName: true });

/** Every word a text holds, lower-cased as the engine reads names: wider
 * than the names it binds, on purpose, since a name it never holds can
 * never be one it defines. */
const WORD = /[A-Za-z0-9_$]+/g;
export function wordsOf(value: unknown, into: Set<string>): void {
  if (typeof value === "string") for (const [word] of value.matchAll(WORD)) into.add(word.toLowerCase());
  else if (Array.isArray(value)) for (const item of value) wordsOf(item, into);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) wordsOf(item, into);
}

export async function readCopySql(scope: DatasetScope, sql: string): Promise<CopyReads | null> {
  try {
    return await boundedEvaluation(async (conn) => {
      const { tables, external } = await queryInputsStrict(conn, sql, () => null);
      const parsed = await serializeSql(conn, await readOnlySql(conn, sql));
      const collected = await collectReferences(conn, parsed.statements ?? []);
      const bound = new Map<string, string>();
      for (const [name, reference] of collected.aliases) {
        // A table named by a string is never bound by that name.
        if (reference.dynamic) continue;
        const classified = classifyReference(reference.parts);
        if (classified.form === "qualified") continue;
        bound.set(name, classified.form === "plain" ? classified.name : reference.parts.at(-1)!.toLowerCase());
      }
      const bindings = collected.bindings.flatMap(({ reference, alias }): Binding[] => {
        const classified = classifyReference(reference.parts);
        // Qualified datasets keep their names and are checked separately.
        if (classified.form === "qualified") return [];
        const plain = classified.form === "plain";
        return [{ table: plain ? classified.name : reference.parts.at(-1)!.toLowerCase(), plain, alias }];
      });
      return { tables, external, bound, bindings, columns: collected.columnRefs };
    }, { scope });
  } catch (error) {
    if (error instanceof ApiError && isBoundedOutcome(error)) throw error;
    return null;
  }
}

/** Every relation and bound column keeps its meaning under the new names. */
export function copyReadsAgree(original: CopyReads, rewritten: CopyReads | null, landed: ReadonlyMap<string, string>): boolean {
  const as = (table: string) => landed.get(table) ?? table;
  const expected = new Set(original.tables.map(as));
  return rewritten !== null &&
    rewritten.external.length === original.external.length && rewritten.external.every(name => original.external.includes(name)) &&
    rewritten.tables.length === expected.size && rewritten.tables.every(name => expected.has(name)) &&
    [...original.bound].every(([name, table]) => rewritten.bound.get(name) === as(table)) &&
    columnsAgree(original, rewritten, as);
}

import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { deriveTableName } from "@/lib/ingest/naming";
import { findOperation } from "@/lib/operations/catalog";
import { queryInputsStrict } from "@/lib/operations/inputs";
import { rewriteTableReferences } from "@/lib/operations/sql-references";
import { boundedEvaluation, isBoundedOutcome } from "@/lib/query/bounded";
import { readOnlySql } from "@/lib/query/guard";
import { classifyReference } from "@/lib/query/reference-forms";
import { collectReferences, serializeSql } from "@/lib/query/references";
import type { AdmittedTemplate } from "./admission";

/**
 * Where a copy's documents name its datasets, bound before anything is
 * written.
 *
 * A template's documents name its datasets and its steps' results by the
 * names they carry in the template, and a copy lands each under that name
 * or the next free one of the copier's. So every reference is rewritten to
 * the name as landed, with the shared reference tools: the scanner finds
 * each occurrence, and the engine's parse of the rewritten text is the
 * check that it reads exactly what the template's read, each name in its
 * place. A renamed table with no alias of its own keeps its old name as
 * one, so a column the query qualifies by that name still finds it; the
 * parse checks that too, every name the template's SQL bound a table by
 * bound to that table as landed, and every column qualified by a table
 * (`stations.geom`, `main.stations.geom`) finding the table it found, as
 * landed: an alias answers to its own name only, so a column qualified by
 * a schema finds nothing once its table is renamed, and the copy is
 * refused.
 *
 * A name a dataset lands under is never a word any of the template's
 * queries uses (a common table expression's name, an alias, a column)
 * other than its own, so a rewritten reference can never be read as
 * something the query defines for itself. The names are only final inside
 * the copy's transaction, so the copy takes them first from what the
 * copier holds, checks the rewrite under exactly those names, and has the
 * transaction take them again: the same names, or the copy checks the new
 * ones and tries again (copy.ts).
 *
 * Each layer's SQL must read the template's datasets and results, and each
 * step its datasets and the results of the steps before it, and nothing
 * else; a reference the copy cannot bind, or a text whose rewrite does not
 * read as it should, refuses the copy whole before any write. Every text is
 * held to what it reads under the landed names, the ones the rewrite left as
 * written too: the admission refuses a template naming its own datasets
 * other than as plain table references (plain-references.ts), and this is
 * where one placed past it is still refused rather than copied. A step's
 * named inputs are rewritten as values, its SQL as a layer's is, and the
 * output it declares takes the name its result lands under.
 */

/** A template name, lower-cased as the engine reads it, to the name it
 * lands under. */
export type LandedNames = ReadonlyMap<string, string>;

export interface CopyReferences {
  /** The names the datasets and results land under, in the template's
   * order, by the suffix rule against `taken` (what the copier holds),
   * never on a word the template's queries use but the name's own. */
  land(taken: ReadonlySet<string>): LandedNames;
  /** Refuse the copy unless every text, rewritten under exactly these
   * names, reads what the template's read, each table bound by the name the
   * template's SQL bound it by. */
  check(landed: LandedNames): Promise<void>;
  /** Each layer's SQL, in the map's order, naming the datasets as landed. */
  layerSql(landed: LandedNames): string[];
  /** Each step's parameters, in the workflow's order, reading and
   * declaring the names as landed. */
  stepParameters(landed: LandedNames): Record<string, unknown>[];
}

function unbound(where: string, name: string | null): never {
  throw new ApiError("template_reference_unbound", name === null
    ? `${where} could not be bound to the datasets the copy makes, so nothing was created.`
    : `${where} names "${name}", which is not a dataset the copy makes, so nothing was created.`, 422);
}

/** A name a reference is rewritten to, or null to leave it as written: a
 * name that lands as itself stays exactly as the template wrote it. */
const renaming = (landed: LandedNames) => (name: string): string | null => {
  const to = landed.get(name);
  return to === undefined || to === name ? null : to;
};

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
interface Reads {
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
 * the template's text, as landed, read as each spelling the engine could
 * take it for: its first one, two or three parts naming a table, the whole
 * column among them, since a column of a table's name alone is its row
 * (`stations`, `main.stations`). */
function columnsAgree(original: Reads, rewritten: Reads, as: (table: string) => string): boolean {
  const named = (reads: Reads, qualifier: string[], to: (table: string) => string) =>
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
const rewrite = (sql: string, landed: LandedNames) => rewriteTableReferences(sql, renaming(landed), { keepBoundName: true });

/** Every word a text holds, lower-cased as the engine reads names: wider
 * than the names it binds, on purpose, since a name it never holds can
 * never be one it defines. */
const WORD = /[A-Za-z0-9_$]+/g;
function wordsOf(value: unknown, into: Set<string>): void {
  if (typeof value === "string") for (const [word] of value.matchAll(WORD)) into.add(word.toLowerCase());
  else if (Array.isArray(value)) for (const item of value) wordsOf(item, into);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) wordsOf(item, into);
}

/** Bind every reference of a template's documents, or refuse the copy. */
export async function bindCopyReferences(scope: AccountScope, admitted: AdmittedTemplate): Promise<CopyReferences> {
  const members = [
    ...admitted.datasets.map((d) => d.name),
    ...(admitted.workflow?.steps ?? []).map((s) => s.output),
  ];
  const own = members.map((name) => name.toLowerCase());
  const steps = admitted.workflow?.steps ?? [];
  // Every word of every query, and every name the template's own members
  // carry: a member lands on none of them but its own.
  const local = new Set(own);
  for (const layer of admitted.map.layers) wordsOf(layer.sql, local);
  for (const step of steps) wordsOf(step.parameters, local);

  const reads = async (sql: string): Promise<Reads | null> => {
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
          // Another person's dataset is no table of the template's: it
          // refuses the copy as a reference outside it.
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
  };

  /** Each text with what it reads as the template wrote it. */
  const texts: { where: string; sql: string; original: Reads }[] = [];
  const bindSql = async (where: string, sql: string, allowed: ReadonlySet<string>) => {
    const original = await reads(sql);
    if (!original) unbound(where, null);
    const outside = original.external[0] ?? original.tables.find((name) => !allowed.has(name));
    if (outside !== undefined) unbound(where, outside);
    texts.push({ where, sql, original });
  };

  const datasets = admitted.datasets.map((d) => d.name.toLowerCase());
  for (const [ordinal, step] of steps.entries()) {
    const where = `The workflow's step ${ordinal + 1}`;
    const allowed = new Set([...datasets, ...steps.slice(0, ordinal).map((s) => s.output.toLowerCase())]);
    for (const input of findOperation(step.operation).inputs) {
      const value = step.parameters[input.name];
      if (typeof value === "string" && value !== "" && !allowed.has(value.toLowerCase())) unbound(where, value);
    }
    if (typeof step.parameters.sql === "string") await bindSql(where, step.parameters.sql, allowed);
  }
  const everything = new Set(own);
  for (const [i, layer] of admitted.map.layers.entries()) {
    await bindSql(`The map's layer ${i + 1} ("${layer.name}")`, layer.sql, everything);
  }

  return {
    land: (taken) => {
      const blocked = new Set(taken);
      const landed = new Map<string, string>();
      for (const member of members) {
        const itself = deriveTableName(member, new Set());
        const name = deriveTableName(member, new Set([...blocked, ...[...local].filter((word) => word !== itself)]));
        blocked.add(name);
        landed.set(member.toLowerCase(), name);
      }
      return landed;
    },
    check: async (landed) => {
      for (const { where, sql, original } of texts) {
        const text = rewrite(sql, landed);
        // Held by what the text reads, never by whether it changed: a name
        // the rewrite does not reach (a table function's listed or computed
        // argument) leaves the text as it was while its dataset lands under
        // another name. An unchanged text reads what the template's read.
        const rewritten = text === sql ? original : await reads(text);
        const as = (table: string) => landed.get(table) ?? table;
        const expected = new Set(original.tables.map(as));
        const same = rewritten !== null && rewritten.external.length === 0 &&
          rewritten.tables.length === expected.size && rewritten.tables.every((name) => expected.has(name)) &&
          // Every name the text binds a table by still binds it, as landed.
          [...original.bound].every(([name, table]) => rewritten.bound.get(name) === as(table)) &&
          columnsAgree(original, rewritten, as);
        if (!same) unbound(where, null);
      }
    },
    layerSql: (landed) => admitted.map.layers.map((layer) => rewrite(layer.sql, landed)),
    stepParameters: (landed) => steps.map((step) => {
      const rename = renaming(landed);
      const parameters: Record<string, unknown> = { ...step.parameters };
      for (const input of findOperation(step.operation).inputs) {
        const value = parameters[input.name];
        if (typeof value !== "string") continue;
        const to = rename(value.toLowerCase());
        if (to !== null) parameters[input.name] = to;
      }
      if (typeof parameters.sql === "string") parameters.sql = rewrite(parameters.sql, landed);
      parameters.name = landed.get(step.output.toLowerCase()) ?? step.output;
      return parameters;
    }),
  };
}

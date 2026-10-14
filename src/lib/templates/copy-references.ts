import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { deriveTableName } from "@/lib/ingest/naming";
import { findOperation } from "@/lib/operations/catalog";
import { copyReadsAgree, readCopySql, rewriteCopySql as rewrite, wordsOf, type CopyReads } from "@/lib/operations/copy-references";
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

  const reads = (sql: string) => readCopySql(scope, sql);

  /** Each text with what it reads as the template wrote it. */
  const texts: { where: string; sql: string; original: CopyReads }[] = [];
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
        const same = copyReadsAgree(original, rewritten, landed);
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

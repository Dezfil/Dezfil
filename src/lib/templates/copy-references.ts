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
 * bound to that table as landed. The names a copy lands under are only
 * known inside its transaction, so the check runs first with stand-in
 * names of the same shape, and the transaction applies the same rewrite
 * with the real ones.
 *
 * Each layer's SQL must read the template's datasets and results, and each
 * step its datasets and the results of the steps before it, and nothing
 * else; a reference the copy cannot bind, or a text whose rewrite does not
 * read as it should, refuses the copy whole before any write. A step's
 * named inputs are rewritten as values, its SQL as a layer's is, and the
 * output it declares takes the name its result lands under.
 */

/** A template name, lower-cased as the engine reads it, to the name it
 * lands under. */
export type LandedNames = ReadonlyMap<string, string>;

export interface CopyReferences {
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

/** What a text reads, by the engine's parse: the tables, the references
 * to other people's datasets, and each name it binds a table by (an alias,
 * or the table's own name), to that table. */
interface Reads {
  tables: string[];
  external: string[];
  bound: Map<string, string>;
}

/** The rewrite of a text, every renamed table keeping the name the text
 * binds it by. */
const rewrite = (sql: string, landed: LandedNames) => rewriteTableReferences(sql, renaming(landed), { keepBoundName: true });

/** Bind every reference of a template's documents, or refuse the copy. */
export async function bindCopyReferences(scope: AccountScope, admitted: AdmittedTemplate): Promise<CopyReferences> {
  const own = [
    ...admitted.datasets.map((d) => d.name.toLowerCase()),
    ...(admitted.workflow?.steps ?? []).map((s) => s.output.toLowerCase()),
  ];
  // Stand-ins of a landed name's shape, distinct from every template name
  // and from one another.
  const taken = new Set(own);
  const standIns = new Map<string, string>();
  for (const name of own) {
    const standIn = deriveTableName(`${name}_copy`, taken);
    taken.add(standIn);
    standIns.set(name, standIn);
  }

  const reads = async (sql: string): Promise<Reads | null> => {
    try {
      return await boundedEvaluation(async (conn) => {
        const { tables, external } = await queryInputsStrict(conn, sql, () => null);
        const parsed = await serializeSql(conn, await readOnlySql(conn, sql));
        const bound = new Map<string, string>();
        for (const [name, reference] of (await collectReferences(conn, parsed.statements ?? [])).aliases) {
          // A table named by a string is never bound by that name.
          if (reference.dynamic) continue;
          const classified = classifyReference(reference.parts);
          if (classified.form === "qualified") continue;
          bound.set(name, classified.form === "plain" ? classified.name : reference.parts.at(-1)!.toLowerCase());
        }
        return { tables, external, bound };
      }, { scope });
    } catch (error) {
      if (error instanceof ApiError && isBoundedOutcome(error)) throw error;
      return null;
    }
  };

  const bindSql = async (where: string, sql: string, allowed: ReadonlySet<string>) => {
    const original = await reads(sql);
    if (!original) unbound(where, null);
    const outside = original.external[0] ?? original.tables.find((name) => !allowed.has(name));
    if (outside !== undefined) unbound(where, outside);
    const rewritten = await reads(rewrite(sql, standIns));
    const expected = new Set(original.tables.map((name) => standIns.get(name)!));
    const same = rewritten !== null && rewritten.external.length === 0 &&
      rewritten.tables.length === expected.size && rewritten.tables.every((name) => expected.has(name)) &&
      // Every name the text binds a table by still binds it, as landed.
      [...original.bound].every(([name, table]) => rewritten.bound.get(name) === (standIns.get(table) ?? table));
    if (!same) unbound(where, null);
  };

  const datasets = admitted.datasets.map((d) => d.name.toLowerCase());
  const steps = admitted.workflow?.steps ?? [];
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

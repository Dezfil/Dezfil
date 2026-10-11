import { ApiError } from "@/lib/api/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { deriveTableName } from "@/lib/ingest/naming";
import { queryInputsStrict } from "@/lib/operations/inputs";
import { rewriteTableReferences } from "@/lib/operations/sql-references";
import { boundedEvaluation, isBoundedOutcome } from "@/lib/query/bounded";
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
 * place. The names a copy lands under are only known inside its
 * transaction, so the check runs first with stand-in names of the same
 * shape, and the transaction applies the same rewrite with the real ones.
 *
 * Each layer's SQL must read the template's datasets and results and
 * nothing else; a reference the copy cannot bind, or a text whose rewrite
 * does not read as it should, refuses the copy whole before any write.
 */

/** A template name, lower-cased as the engine reads it, to the name it
 * lands under. */
export type LandedNames = ReadonlyMap<string, string>;

export interface CopyReferences {
  /** Each layer's SQL, in the map's order, naming the datasets as landed. */
  layerSql(landed: LandedNames): string[];
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

  const reads = async (sql: string) => {
    try {
      return await boundedEvaluation((conn) => queryInputsStrict(conn, sql, () => null), { scope });
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
    const rewritten = await reads(rewriteTableReferences(sql, renaming(standIns)));
    const expected = new Set(original.tables.map((name) => standIns.get(name)!));
    const same = rewritten !== null && rewritten.external.length === 0 &&
      rewritten.tables.length === expected.size && rewritten.tables.every((name) => expected.has(name));
    if (!same) unbound(where, null);
  };

  const everything = new Set(own);
  for (const [i, layer] of admitted.map.layers.entries()) {
    await bindSql(`The map's layer ${i + 1} ("${layer.name}")`, layer.sql, everything);
  }

  return {
    layerSql: (landed) => admitted.map.layers.map((layer) => rewriteTableReferences(layer.sql, renaming(landed))),
  };
}

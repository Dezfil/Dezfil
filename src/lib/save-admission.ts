import type { AccountScope } from "@/lib/auth/scope";
import { reachableDatasetIds, requireReachable } from "@/lib/auth/reach";
import { findOperation } from "@/lib/operations/catalog";
import { boundedEvaluation } from "@/lib/query/bounded";
import { resolveParameter, resolveSql, unavailableDataset, type Resolution } from "@/lib/query/bindings";
import { mapEvaluation, workflowEvaluation, type EvaluationContext } from "@/lib/query/context";
import { bindsAsRelation } from "@/lib/query/named-sql";
import { bindingNamespace, namespaceFor } from "@/lib/query/namespace";

/**
 * SQL and dataset parameters saved into someone else's map or workflow.
 *
 * When the acting account is not the resource's owner (an editor, or the
 * project's owner acting as one), every dataset the SQL or the parameter
 * names must resolve, through the identity resolver, in the resource's SQL
 * home within the actor's own reach at that moment; otherwise the save is
 * refused naming the reference as written, and nothing is written. So nobody
 * lodges in another person's map or workflow a reference they could not
 * evaluate themselves, for the owner's renders, runs or publication to
 * evaluate on their behalf. A workflow's declared outputs are exempt: they
 * may not exist yet, and the ordering rules decide whether a step may read
 * them. The engine's own relations name no dataset and pass. SQL whose
 * references cannot be read is refused with the reason the engine gives,
 * since nothing could then say what it names.
 *
 * The owner's own saves are not checked here: they keep their behavior.
 */

/** One dataset an admitted save binds, with the reference that named it. */
interface Bound { id: string; written: string }

/** What an admission bound, rechecked when the save commits. */
export interface SavedAdmission { readonly bound: readonly Bound[] }

const NOTHING: SavedAdmission = Object.freeze({ bound: [] });

/** Whether the acting account saves into this map or workflow as its owner,
 * whose saves are not checked. */
export function savesAsOwner(scope: AccountScope, kind: "map" | "layer" | "workflow" | "step", id: string): boolean {
  return requireReachable(scope, kind, id).relation === "owner";
}

function refusalOf(resolution: Resolution, written: string): Error | null {
  if (resolution.status === "unbound") return unavailableDataset(written);
  return null;
}

/** Admit SQL saved into a map or workflow in its evaluation context: its
 * home, the actor's reach and, for a workflow, its declared outputs. */
export async function admitSavedSql(evaluation: EvaluationContext, sql: string, signal?: AbortSignal): Promise<SavedAdmission> {
  return boundedEvaluation(async (conn) => {
    const { reads } = await resolveSql(conn, sql, bindingNamespace(conn, evaluation));
    const bound: Bound[] = [];
    for (const read of reads) {
      const { resolution } = read;
      if (resolution.status === "bound") {
        if (!resolution.output) bound.push({ id: resolution.dataset.id, written: read.written });
        continue;
      }
      if (resolution.status !== "unbound") continue;
      // A plain name the namespace does not hold may still be one of the
      // engine's own relations, which names no dataset.
      if (!resolution.external && await bindsAsRelation(conn, read.reference.parts)) continue;
      throw refusalOf(resolution, read.written)!;
    }
    return { bound };
  }, { scope: evaluation, signal });
}

/** Admit a stored dataset parameter, a plain or qualified dataset name. */
export function admitSavedParameter(evaluation: EvaluationContext, value: string): SavedAdmission {
  const { resolution } = resolveParameter(namespaceFor(evaluation), value);
  const refusal = refusalOf(resolution, value);
  if (refusal) throw refusal;
  return resolution.status === "bound" && !resolution.output
    ? { bound: [{ id: resolution.dataset.id, written: value }] } : NOTHING;
}

/** SQL saved into a map by someone other than its owner. */
export async function admitMapSql(scope: AccountScope, mapId: string, sql: string, signal?: AbortSignal): Promise<SavedAdmission> {
  if (savesAsOwner(scope, "map", mapId)) return NOTHING;
  return admitSavedSql(mapEvaluation(scope, mapId) as EvaluationContext, sql, signal);
}

/** A workflow step's definition saved by someone other than the workflow's
 * owner: the datasets its declared inputs name and the SQL it carries. */
export async function admitStepDefinition(scope: AccountScope, recipeId: string, operationId: string,
  parameters: Record<string, unknown>, signal?: AbortSignal): Promise<SavedAdmission> {
  if (savesAsOwner(scope, "workflow", recipeId)) return NOTHING;
  const evaluation = workflowEvaluation(scope, recipeId);
  const bound: Bound[] = [];
  for (const input of findOperation(operationId).inputs) {
    const value = parameters[input.name];
    if (typeof value === "string" && value !== "") bound.push(...admitSavedParameter(evaluation, value).bound);
  }
  if (typeof parameters.sql === "string" && parameters.sql.trim() !== "") {
    bound.push(...(await admitSavedSql(evaluation, parameters.sql, signal)).bound);
  }
  return { bound };
}

/** The commit's recheck, inside its transaction: every dataset the admission
 * bound must still be within the actor's reach, else the save is refused
 * naming it, and nothing is written. */
export function recheckSaved(scope: AccountScope, ...admissions: (SavedAdmission | undefined)[]): void {
  const pending = admissions.flatMap((admission) => admission?.bound ?? []);
  if (pending.length === 0) return;
  const reach = reachableDatasetIds(scope);
  const lost = pending.find((entry) => !reach.has(entry.id));
  if (lost) throw unavailableDataset(lost.written);
}

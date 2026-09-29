import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import {
  currentProducers,
  dependencyOf,
  type MapDependency,
} from "@/lib/map-dependencies";
import { requireRecipe, listSteps } from "@/lib/metadata/owned-recipes";
import { queryInputsStrict } from "@/lib/operations/inputs";
import {
  currentDefinition,
  declaredReads,
  type StepDefinition,
} from "@/lib/operations/step-reads";
import { boundedEvaluation } from "@/lib/query/bounded";
import { listTablesWithSize } from "@/lib/table-service";

/**
 * The datasets a workflow reads and writes: the subject of the filing
 * checklist for a workflow, as one documented read. Once each: every
 * registered dataset the workflow's CURRENT node definitions read (a
 * pending edit over the active one — the same selection the ordinary
 * workflow view makes) and every current registered output of the
 * workflow; a dataset both read and written appears once. One captured
 * metadata world, like the map's read.
 *
 * Strict where the ordinary view is tolerant: that view turns an
 * unreadable definition into zero reads so a canvas mid-edit still
 * renders; a filing checklist that quietly omitted a dataset would move
 * a workflow without what it depends on, so an unanalyzable definition
 * fails the WHOLE read (`dependencies_unresolved`, the rule), never a
 * partial answer.
 */

export type WorkflowDependency = MapDependency;

async function strictReads(step: StepDefinition): Promise<string[]> {
  const declared = declaredReads(step);
  if (declared !== null) return declared;
  const params = currentDefinition(step);
  const sql = typeof params.sql === "string" ? params.sql : "";
  if (!sql) return [];
  return boundedEvaluation(async (conn) =>
    (await queryInputsStrict(conn, sql, () => null)).tables,
  );
}

export async function workflowDependencies(
  scope: AccountScope,
  recipeId: string,
): Promise<WorkflowDependency[]> {
  requireRecipe(scope, recipeId);
  const steps = listSteps(scope, recipeId);

  const tables = await listTablesWithSize(scope);
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const byId = new Map(tables.map((t) => [t.id, t]));
  const producers = currentProducers();

  const found = new Map<string, WorkflowDependency>();
  for (const step of steps) {
    let names: string[];
    try {
      names = await strictReads(step);
    } catch (cause) {
      throw new ApiError(
        "dependencies_unresolved",
        `The node at position ${step.ordinal + 1} (${step.operation}) ` +
          `could not be analyzed, so the workflow's datasets cannot be ` +
          `listed completely. ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        422,
      );
    }
    for (const name of names) {
      const table = byName.get(name.toLowerCase());
      if (table && !found.has(table.id)) {
        found.set(table.id, dependencyOf(table, producers));
      }
    }
    const output = step.outputTableId ? byId.get(step.outputTableId) : null;
    if (output && !found.has(output.id)) {
      found.set(output.id, dependencyOf(output, producers));
    }
  }
  requireRecipe(scope, recipeId);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

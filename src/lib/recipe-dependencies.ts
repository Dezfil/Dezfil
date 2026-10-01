import type { DatasetScope } from "@/lib/query/access";
import type { AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import {
  currentProducers,
  dependencyOf,
  readerSqlName,
  type MapDependency,
} from "@/lib/map-dependencies";
import { metadataDb } from "@/lib/metadata/db";
import { requireRecipe, listSteps } from "@/lib/metadata/owned-recipes";
import { queryInputsStrict } from "@/lib/operations/inputs";
import {
  currentDefinition,
  declaredReads,
  type StepDefinition,
} from "@/lib/operations/step-reads";
import { boundedEvaluation } from "@/lib/query/bounded";
import { listTablesWithSize } from "@/lib/table-service";
import { resolveReference } from "@/lib/query/bindings";
import { workflowEvaluation } from "@/lib/query/context";
import { namespaceFor } from "@/lib/query/namespace";
import { qualifiedNameParts } from "@/lib/query/qualified-name";

/**
 * The datasets a workflow reads and writes: the subject of the filing
 * checklist for a workflow, as one documented read. Once each: every
 * registered dataset the workflow's CURRENT node definitions read (a
 * pending edit over the active one — the same selection the ordinary
 * workflow view makes) and every runner's recorded output of the
 * workflow the reader reaches; a dataset both read and written appears
 * once. One captured
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

/** Every dataset reference a step's current definition makes, as parts:
 * its declared dataset parameters, or its SQL's plain and qualified table
 * references. */
async function strictReads(scope: DatasetScope, step: StepDefinition): Promise<string[][]> {
  const declared = declaredReads(step);
  if (declared !== null) return declared.map((value) => qualifiedNameParts(value) ?? [value]);
  const params = currentDefinition(step);
  const sql = typeof params.sql === "string" ? params.sql : "";
  if (!sql) return [];
  const inputs = await boundedEvaluation(async (conn) => queryInputsStrict(conn, sql, () => null), { scope });
  return [...inputs.tables.map((name) => [name]), ...(inputs.external ?? []).map((written) => qualifiedNameParts(written) ?? [written])];
}

export async function workflowDependencies(
  scope: AccountScope,
  recipeId: string,
): Promise<WorkflowDependency[]> {
  requireRecipe(scope, recipeId);
  const steps = listSteps(scope, recipeId);

  // Every name binds in the workflow's home within the reader's reach, the
  // workflow's own outputs as the reader would run them: never a same-named
  // dataset of the reader's own, and nothing out of reach is named.
  const evaluation = workflowEvaluation(scope, recipeId);
  const namespace = namespaceFor(evaluation);
  const tables = await listTablesWithSize(scope);
  const byId = new Map(tables.map((t) => [t.id, t]));
  const producers = currentProducers(scope);
  const reader = readerSqlName(scope);
  // Every runner's recorded output of each node, as the reader reaches it.
  const outputsOf = metadataDb().prepare("SELECT output_table_id AS id FROM step_runner_outputs WHERE step_id = ? ORDER BY succeeded_at DESC");

  const found = new Map<string, WorkflowDependency>();
  for (const step of steps) {
    let references: string[][];
    try {
      references = await strictReads(evaluation, step);
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
    for (const parts of references) {
      const resolution = resolveReference(namespace, parts);
      const table = resolution.status === "bound" ? byId.get(resolution.dataset.id) : undefined;
      if (table && !found.has(table.id)) {
        found.set(table.id, dependencyOf(table, producers, reader));
      }
    }
    for (const { id } of outputsOf.all(step.id) as { id: string }[]) {
      const output = byId.get(id);
      if (output && !found.has(output.id)) found.set(output.id, dependencyOf(output, producers, reader));
    }
  }
  requireRecipe(scope, recipeId);
  return [...found.values()].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
}

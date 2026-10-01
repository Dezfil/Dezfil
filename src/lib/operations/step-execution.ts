import { archiveCascadeAttempt } from "@/lib/metadata/cascades";
import { requireCascadeMember } from "@/lib/metadata/owned-cascades";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { deriveTableName } from "@/lib/ingest/naming";
import type { Database } from "better-sqlite3";
import type { OperationJob } from "@/lib/metadata/jobs";
import { admitOwned, submitRun } from "./run";
import { planPublication, stepAuthorizer } from "./step-run";
import { recipeStanding } from "@/lib/metadata/owned-recipes";
import { getStep as getStepRow } from "@/lib/metadata/recipes";
import { fileTable } from "@/lib/metadata/owned-projects";
import { mayFileInto, requirePermitted } from "@/lib/auth/reach";
import { workflowEvaluation } from "@/lib/query/context";

/**
 * Running one recipe step.
 *
 * This is where the three halves meet: what the step means right now, the
 * narrow admission exception that lets a re-run reuse its own output's name,
 * and the publication that records ownership and lineage with the job's own
 * success.
 *
 * **The exception is granted from stored state, never from the request.** The
 * plan reads the step row to decide whether it still owns a live table under
 * exactly the id and name it recorded; only then is a taken name admitted, and
 * only for that table. `subject` travels with the run as a grouping identity
 * and is never consulted here — a caller who sends a step's id as their subject
 * gets history grouping and nothing else.
 *
 * **A renamed output is not a replacement.** If a proposal changes the output's
 * name, the run registers a new dataset under the new name by the ordinary
 * rules — including being refused if that name is taken — and the old table
 * stays exactly where it was. Treating a rename as a replacement would silently
 * move a table other layers point at.
 *
 * **The run is its runner's.** Anyone who may run the workflow (its owner,
 * the project's owner acting as an editor, an editor) runs a step as
 * themselves: it reads in the workflow's home within the runner's reach, the
 * job is the runner's, the output is created in the runner's own space and
 * never replaces or alters anyone else's dataset, and an unrelated dataset of
 * the runner's already holding the name is refused by the ordinary name rule.
 */
export interface StepRunOptions {
  /**
   * The cascade this run is a member of, if any.
   *
   * Given, the member's success and the dataset it published are written **in
   * the publication transaction**. Correlating afterwards by reading the job
   * back cannot be made safe: history is capped per subject, so a concurrent
   * run of the same step can evict the job between its settlement and the
   * cascade's read, and the cascade would then record a succeeded member as
   * failed with no output.
   */
  cascadeId?: string;
}

export async function startStepRun(
  scope: AccountScope,
  stepId: string,
  options: StepRunOptions = {},
): Promise<OperationJob> {
  requireAccountScope(scope);
  // Admitted only for an account that may run the workflow now.
  requirePermitted(scope, "step", stepId, "run");
  const plan = planPublication(scope, stepId);
  if (options.cascadeId) requireCascadeMember(scope, options.cascadeId, stepId);
  // The step reads in its workflow's home, with this runner's reach and the
  // workflow's declared outputs as this runner has produced them.
  const evaluation = workflowEvaluation(scope, plan.step.recipeId);

  const admitted = await admitOwned(
    scope,
    {
      operation: plan.step.operation,
      parameters: plan.running,
      // A step's runs are one subject, so its history is its own.
      subject: plan.step.id,
    },
    plan.replaceTable,
    evaluation,
  );

  if (options.cascadeId) requireCascadeMember(scope, options.cascadeId, stepId);

  // The registry's name, not the typed one — the same sanitization admission
  // checked against, so "is this the table we own" is asked of one string.
  const registered = deriveTableName(admitted.name, new Set());
  const replaceTable =
    plan.replaceTable && plan.replaceTable.name === registered
      ? plan.replaceTable
      : undefined;

  return submitRun(scope, {
    operationId: admitted.operationId,
    parameters: plan.running,
    sql: admitted.sql,
    name: admitted.name,
    subject: plan.step.id,
    // Not `client`: a caller may send any subject id, so a step's history is
    // told apart by a kind nothing outside this path can mint.
    subjectKind: "step",
    ...(admitted.measurement ? { measurement: admitted.measurement } : {}),
    ...(admitted.warnings ? { warnings: admitted.warnings } : {}),
    ...(admitted.bindings ? { bindings: admitted.bindings } : {}),
    evaluation,
    // A step runs a prepared verb exactly as a one-off run does: the
    // preparation is part of what was admitted, and dropping it here would
    // publish a statement that does not exist.
    ...(admitted.prepare ? { prepare: admitted.prepare } : {}),
    ...(replaceTable ? { replaceTable } : {}),
    ...(options.cascadeId ? { onSettled: (jobId: string) => archiveCascadeAttempt(options.cascadeId!, stepId, jobId) } : {}),
    publisher: (jobFinished, jobId) =>
      stepAuthorizer(scope, plan, jobFinished, options.cascadeId, jobId),
    onPublished: stepOutputFiler(scope, plan.step.id),
  });
}

/** The output follows the workflow's project as it is AT THE PUBLISHING
 * COMMIT — read inside the publication transaction, never captured at
 * run start — and is filed there only when the runner may file into that
 * project then (its owner, or an editor, while its owner is active).
 * Otherwise the output completes unfiled. Exported so the race test
 * exercises the exact function production runs. */
export function stepOutputFiler(scope: AccountScope, stepId: string) {
  return (table: { id: string }, db: Database): void => {
    const current = getStepRow(stepId, db);
    const projectId = current ? recipeStanding(current.recipeId, db)?.projectId : null;
    if (projectId && mayFileInto(scope, projectId, db)) fileTable(scope, table.id, projectId, db);
  };
}

import type { AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requireCancellable, requirePermitted, requireReachable, type Reached } from "@/lib/auth/reach";

/**
 * The checks of the workflow writes that name a step or a run under their
 * workflow. A step or run named under another workflow is absent, whatever
 * the caller reaches; then the kernel decides.
 */

/** A content change to a workflow or one of its steps: the owner's, the
 * project owner's acting as an editor, and an editor's. */
export function requireWorkflowEdit(scope: AccountScope, recipeId: string, stepId?: string): Reached {
  if (stepId !== undefined && requireReachable(scope, "step", stepId).parentId !== recipeId) throw resourceAbsent();
  return stepId === undefined
    ? requirePermitted(scope, "workflow", recipeId, "edit")
    : requirePermitted(scope, "step", stepId, "edit");
}

/**
 * Planning or starting a run of a workflow, or of one step: the owner's, the
 * project owner's acting as an editor, and an editor's. The run is its
 * runner's, its outputs the runner's own datasets. A viewer is refused by the
 * permission shape, before anything is planned or admitted.
 */
export function requireWorkflowRunStart(scope: AccountScope, recipeId: string, stepId?: string): Reached {
  if (stepId !== undefined && requireReachable(scope, "step", stepId).parentId !== recipeId) throw resourceAbsent();
  return stepId === undefined
    ? requirePermitted(scope, "workflow", recipeId, "run")
    : requirePermitted(scope, "step", stepId, "run");
}

/** Cancelling a run named under its workflow: its initiator or the
 * workflow's owner. */
export function requireRunCancellation(scope: AccountScope, recipeId: string, runId: string): Reached {
  if (requireReachable(scope, "cascade", runId).parentId !== recipeId) throw resourceAbsent();
  return requireCancellable(scope, runId);
}

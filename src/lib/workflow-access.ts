import type { AccountScope } from "@/lib/auth/scope";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { permissionRefused, requireCancellable, requirePermitted, requireReachable, type Reached } from "@/lib/auth/reach";

/**
 * Workflow writes whose answer is the recipe, step or run view.
 *
 * That view is still read in the caller's own space: its reads, lineage,
 * conditions and attempts resolve against the caller's datasets and jobs. So
 * until it is defined for someone who reaches a workflow without owning it,
 * these writes are the owner's: the kernel's refusals come first (absent for
 * anyone who does not reach the workflow, the permission refusal for a viewer),
 * then anyone else who reaches it is refused by the permission shape, before
 * anything is read or written. Writes that answer without the view (the
 * layout, deletion) ask the kernel alone.
 */
export function requireWorkflowViewWrite(scope: AccountScope, recipeId: string, action: "edit" | "run",
  stepId?: string): Reached {
  // A step named under another workflow is absent, whatever the caller reaches.
  if (stepId !== undefined && requireReachable(scope, "step", stepId).parentId !== recipeId) throw resourceAbsent();
  const reached = stepId === undefined
    ? requirePermitted(scope, "workflow", recipeId, action)
    : requirePermitted(scope, "step", stepId, action);
  if (reached.relation !== "owner") throw permissionRefused();
  return reached;
}

/** Cancelling a run named under its workflow: the kernel's cancellation rule
 * (the initiator or the workflow's owner), and, while the answer is the run
 * view, the owner alone. */
export function requireViewableCancellation(scope: AccountScope, recipeId: string, runId: string): Reached {
  // A run named under another workflow is absent, whatever the caller reaches.
  if (requireReachable(scope, "cascade", runId).parentId !== recipeId) throw resourceAbsent();
  const reached = requireCancellable(scope, runId);
  if (reached.relation !== "owner") throw permissionRefused();
  return reached;
}

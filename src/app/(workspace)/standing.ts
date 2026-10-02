import { canReach, isPermitted, type ReachKind } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";

type Shown = Extract<ReachKind, "map" | "workflow">;

/**
 * Whether a page shows a map or workflow read-only: the reader reaches it
 * but may not change its contents, as the reach kernel holds it at the
 * page's request. That is a project's Viewer, and also everyone, Editors and
 * the project's owner included, while the resource's owner is deactivated
 * and its contents are frozen: they read it rather than get an editor whose
 * every save is refused. Decided once on the server, so nothing in the
 * browser can turn a read-only page into an editor's; a resource the reader
 * cannot reach is left to the page's own absent answer.
 */
export function viewsOnly(scope: AccountScope, kind: Shown, id: string): boolean {
  if (!canReach(scope, kind, id)) return false;
  return !isPermitted(scope, kind, id, "edit");
}

/** Whether a workflow's page offers its runs: whoever may run it, which a
 * frozen workflow still allows to its Editors and its project's owner. A
 * Viewer never runs. */
export function runsWorkflow(scope: AccountScope, id: string): boolean {
  return canReach(scope, "workflow", id) && isPermitted(scope, "workflow", id, "run");
}

import { canReach, requireReachable, type ReachKind } from "@/lib/auth/reach";
import type { AccountScope } from "@/lib/auth/scope";

/**
 * Whether a page shows a map or workflow read-only: the reader is one of
 * its project's Viewers and not its owner, as the reach kernel holds it at
 * the page's request. Decided once on the server, so nothing in the browser
 * can turn a Viewer's page into an editor's; a resource the reader cannot
 * reach is left to the page's own absent answer.
 */
export function viewsOnly(scope: AccountScope, kind: Extract<ReachKind, "map" | "workflow">, id: string): boolean {
  if (!canReach(scope, kind, id)) return false;
  return requireReachable(scope, kind, id).relation === "viewer";
}

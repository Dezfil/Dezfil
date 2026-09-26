import type { RecoveryAction } from "@/lib/assistant/runs";

/** Product effects, including uncertain mutations, reconcile authoritative
 * builder state. Read-only POSTs and refused/unfinished actions do not. */
export function requiresRefresh(actions: RecoveryAction[]): boolean {
  return actions.some((action) => ["succeeded", "accepted", "uncertain"].includes(action.status)
    && action.effects?.readOnly === false && action.effects.writes.length > 0);
}

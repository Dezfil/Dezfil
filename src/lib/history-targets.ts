import type { AccountScope } from "@/lib/auth/scope";
import { AuthError } from "@/lib/auth/errors";
import { ApiError } from "@/lib/api/errors";
import type { AccountActor } from "./account-actor";
import { accountActors } from "./metadata/account-actors";
import type { HistoryStep } from "./metadata/history";
import type { Layer, MapRecord } from "./metadata/maps";
import { requireMapFor } from "./map-access";
import { historyChangesPublication, requireLivePublicationChange } from "./publication-settings";
import { admitHistoryTarget } from "./history-admission-cache";

export interface HistoryTarget {
  steps: { id: string; scope: HistoryStep["scope"]; targetId: string; op: HistoryStep["op"]; author: AccountActor | null; createdAt: string }[];
  eligible: boolean;
  reason: string | null;
}

/** Explain the complete contiguous target using the same admission rules as
 * replay. Unknown historic actors stay unknown, including after transfer. */
export async function historyTarget(scope: AccountScope, map: MapRecord, layers: Layer[], steps: HistoryStep[], direction: "undo" | "redo", revision: string): Promise<HistoryTarget | null> {
  if (!steps.length) return null;
  const labels = accountActors(steps.map(step => step.authorId));
  const target: HistoryTarget = {
    steps: steps.map(step => ({ id: step.id, scope: step.scope, targetId: step.targetId, op: step.op,
      author: step.authorId ? labels.get(step.authorId) ?? null : null, createdAt: step.createdAt })),
    eligible: true, reason: null,
  };
  try {
    requireMapFor(scope, map.id, "edit");
    if (historyChangesPublication(map, layers, steps, direction)) {
      requireMapFor(scope, map.id, "publish");
      requireLivePublicationChange(scope, map.id);
    }
    await admitHistoryTarget(scope, map.id, revision, steps, direction);
  } catch (error) {
    if (!(error instanceof ApiError || error instanceof AuthError)) throw error;
    target.eligible = false;
    target.reason = error.message;
  }
  return target;
}

import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireViewableCancellation } from "@/lib/workflow-access";
import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { getCascade } from "@/lib/metadata/owned-cascades";
import { cancelCascade, readCascade } from "@/lib/operations/cascade";
import { cascadePayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string; runId: string }> };

/**
 * Stop a recipe run.
 *
 * One thing to cancel, whatever it was in the middle of: what has not started
 * never starts. Every member found running when cancellation is accepted is
 * cancelled before any member settlement is awaited. Only a member already
 * terminal at acceptance stays finished, and its output stands. Running
 * members are interrupted **in the engine**, not only in the record. The run's
 * own outcome is then `cancelled`, written once the last in-flight member has
 * settled.
 *
 * Cancelling one that has already finished is not an error — "make sure this is
 * not running" is already true of it.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, runId } = await params;
    // The run's initiator or its workflow's owner; the owner alone while the
    // answer is the run view.
    requireViewableCancellation(scope, id, runId);
    const existing = getCascade(scope, runId);
    if (!existing || existing.recipeId !== id) {
      throw resourceAbsent();
    }
    await cancelCascade(scope, runId);
    requireOwnedResource(scope, "cascade", runId);
    return NextResponse.json({ run: cascadePayload(readCascade(scope, runId)) });
  } catch (error) {
    return errorResponse(error);
  }
}

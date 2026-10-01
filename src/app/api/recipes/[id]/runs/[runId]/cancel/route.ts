import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireRunCancellation } from "@/lib/workflow-access";
import { canReach } from "@/lib/auth/reach";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
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
 *
 * The run's initiator keeps this right after they stop reaching its workflow,
 * by the run's identifier: the run is their work. They are answered 204 with
 * no body, since cancelling grants no view of a workflow they cannot reach.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, runId } = await params;
    // The run's initiator, reaching it or not, or its workflow's owner.
    requireRunCancellation(scope, id, runId);
    await cancelCascade(scope, runId);
    if (!canReach(scope, "cascade", runId)) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ run: cascadePayload(readCascade(scope, runId)) });
  } catch (error) {
    return errorResponse(error);
  }
}

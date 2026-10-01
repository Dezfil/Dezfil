import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireWorkflowRunStart } from "@/lib/workflow-access";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { readCascade, startSingleRun } from "@/lib/operations/cascade";
import { cascadePayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string; stepId: string }> };

/**
 * Run one step.
 *
 * Answers **202** with the run, exactly as the operation endpoint does: an
 * accepted run outlives the request that started it, and the caller polls the
 * recipe's own `/api/recipes/{id}/runs/{runId}` resource for its outcome.
 *
 * **This runs the step and nothing else.** Carrying its dependents is the
 * recipe-run endpoint's job, and keeping the two apart is what makes the
 * confirmation property honest — a control that sometimes ran three other
 * steps could not be described as narrow.
 *
 * A re-run replaces the step's output in place, keeping its id and name, so
 * every layer built on that table keeps pointing at fresh data.
 *
 * Ordinarily, an admission refusal leaves no run and no attempt. The narrow
 * exception is a run already listable when cancellation is accepted: a later
 * refusal leaves that cancelled run with its refusal member and no attempt.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id, stepId } = await params;
    // Starting a run stays the workflow owner's until a run's outputs are its
    // runner's own; anyone else who may run it is refused by the permission
    // shape.
    requireWorkflowRunStart(scope, id, stepId);
    // A node's own run is one of the recipe's runs: one member, the same
    // lock, the same driver. Ordinary refusal removes it before the request
    // answers; accepted cancellation retains the listable exception.
    const run = await startSingleRun(scope, id, stepId);
    return NextResponse.json(
      { run: cascadePayload(readCascade(scope, run.id)) },
      {
        status: 202,
        headers: { Location: `/api/recipes/${id}/runs/${run.id}` },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

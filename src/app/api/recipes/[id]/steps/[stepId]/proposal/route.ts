import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireWorkflowViewWrite } from "@/lib/workflow-access";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { discardProposal, getStep } from "@/lib/metadata/owned-recipes";
import { readStep } from "@/lib/operations/recipe-view";
import { stepPayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string; stepId: string }> };

/**
 * Discard a step's pending edit: the step goes back to meaning its active
 * definition — what its output was produced from — and nothing else
 * changes. A step holding no pending edit is unchanged, and the answer
 * says so.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id, stepId } = await params;
    requireWorkflowViewWrite(scope, id, "edit", stepId);
    const step = getStep(scope, stepId);
    if (!step || step.recipeId !== id) {
      throw resourceAbsent();
    }
    const discarded = step.proposedParameters !== null;
    if (discarded) discardProposal(scope, stepId);
    return NextResponse.json({
      step: stepPayload(await readStep(scope, id, stepId)),
      discarded,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

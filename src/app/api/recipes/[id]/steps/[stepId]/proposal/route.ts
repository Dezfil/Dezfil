import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { discardProposal, getRecipe, getStep } from "@/lib/metadata/recipes";
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
    const { id, stepId } = await params;
    if (!getRecipe(id)) {
      throw new ApiError("not_found", `No recipe with id "${id}".`, 404);
    }
    const step = getStep(stepId);
    if (!step || step.recipeId !== id) {
      throw new ApiError("not_found", `No step with id "${stepId}" in this recipe.`, 404);
    }
    const discarded = step.proposedParameters !== null;
    if (discarded) discardProposal(stepId);
    return NextResponse.json({
      step: stepPayload(await readStep(id, stepId)),
      discarded,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

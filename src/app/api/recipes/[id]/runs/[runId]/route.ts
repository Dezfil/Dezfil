import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { readCascade } from "@/lib/operations/cascade";
import { cascadePayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string; runId: string }> };

/**
 * Read a recipe run.
 *
 * Its own outcome — completed, partly completed, failed, cancelled or
 * interrupted — plus every member: what became of it, the ordinary run it
 * minted, and for one that was never attempted, what stopped it. A member
 * reported `not_run` has **no** run id, because nothing was minted for it.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id, runId } = await params;
    const cascade = readCascade(runId);
    if (cascade.recipeId !== id) {
      throw new ApiError(
        "not_found",
        `No run with id "${runId}" on this recipe.`,
        404,
      );
    }
    return NextResponse.json({ run: cascadePayload(cascade) });
  } catch (error) {
    return errorResponse(error);
  }
}

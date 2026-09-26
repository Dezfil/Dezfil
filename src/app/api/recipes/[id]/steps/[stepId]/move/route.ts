import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import { getRecipe, getStep, listSteps, moveStep } from "@/lib/metadata/recipes";
import { assertOrderingValid } from "@/lib/operations/recipe-order";
import { readRecipe } from "@/lib/operations/recipe-view";
import { readsByStep } from "@/lib/operations/step-reads";
import { jsonBody, recipePayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string; stepId: string }> };

/**
 * Reorder a step.
 *
 * **The whole proposed ordering is checked, not the step that moved.** Dragging
 * a producer downwards breaks its consumers rather than itself, so validating
 * only the moved step would pass a reorder that leaves the recipe invalid.
 *
 * The check and the move share one transaction: a refusal must leave the
 * recipe exactly as it was, and a validated ordering must be the one that
 * lands.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id, stepId } = await params;
    if (!getRecipe(id)) {
      throw new ApiError("not_found", `No recipe with id "${id}".`, 404);
    }
    const step = getStep(stepId);
    if (!step || step.recipeId !== id) {
      throw new ApiError(
        "not_found",
        `No step with id "${stepId}" in this recipe.`,
        404,
      );
    }
    const body = await jsonBody(request);
    if (typeof body.ordinal !== "number" || !Number.isInteger(body.ordinal)) {
      throw new ApiError(
        "invalid_request",
        `"ordinal" must be an integer position in the recipe.`,
        400,
      );
    }

    const steps = listSteps(id);
    // Resolving what each step reads needs the engine's parser, which is
    // asynchronous — so the arrangement this validates is a snapshot, and a
    // concurrent edit can make it stale before the move lands. The move
    // therefore commits only if nothing changed underneath it.
    const stamp = (list: typeof steps) =>
      list.map((s) => `${s.id}:${s.ordinal}:${s.updatedAt}`).join("|");
    const before = stamp(steps);
    const reads = await readsByStep(steps);
    const target = Math.max(0, Math.min(body.ordinal, steps.length - 1));
    const proposed = steps.filter((s) => s.id !== stepId);
    proposed.splice(target, 0, step);
    assertOrderingValid(proposed, reads);

    const db = metadataDb();
    db.transaction(() => {
      // Re-read inside the commit. Without this the promised refusal is
      // only true of an arrangement nobody may still be in.
      if (stamp(listSteps(id, db)) !== before) {
        throw new ApiError(
          "invalid_request",
          `This recipe changed while the move was being checked. Read it ` +
            `again and retry.`,
          409,
        );
      }
      moveStep(stepId, target, db);
    })();

    return NextResponse.json({ recipe: recipePayload(await readRecipe(id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { deleteRecipe, getRecipe, renameRecipe } from "@/lib/metadata/recipes";
import { readRecipe } from "@/lib/operations/recipe-view";
import { jsonBody, recipeName, recipePayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json({ recipe: recipePayload(await readRecipe(id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await jsonBody(request);
    if (!renameRecipe(id, recipeName(body))) {
      throw new ApiError("not_found", `No recipe with id "${id}".`, 404);
    }
    return NextResponse.json({ recipe: recipePayload(await readRecipe(id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Delete a recipe.
 *
 * **Its output tables survive**, and the published description says so: a
 * recipe is the record of how its datasets were made, not their owner. This is
 * the disclosure the confirmation is *for* — a user who expects the tables to
 * go with it has been told the wrong thing.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const recipe = getRecipe(id);
    if (!recipe || !deleteRecipe(id)) {
      throw new ApiError("not_found", `No recipe with id "${id}".`, 404);
    }
    return NextResponse.json({
      deleted: id,
      outputsRemain: true,
      message:
        "The recipe was deleted. The datasets its steps produced remain in " +
        "the workspace. A recipe records how they were made, it does not " +
        "own them.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

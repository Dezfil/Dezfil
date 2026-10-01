import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { duplicateRecipe } from "@/lib/operations/recipe-duplicate";
import { readRecipe } from "@/lib/operations/recipe-view";
import { recipePayload } from "@/lib/operations/recipe-api";
import { permissionRefused, requirePermitted } from "@/lib/auth/reach";

type Params = { params: Promise<{ id: string }> };

/**
 * Duplicate a recipe: a workflow named "<name> copy" that has never run, with
 * every output renamed to a free name and every read of an original output
 * redirected to the copy's. The original and its datasets are untouched.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    // Duplication stays the owner's until a copy can be made under reach:
    // anyone else who reaches the workflow is refused by the permission shape.
    if (requirePermitted(scope, "workflow", id, "duplicate").relation !== "owner") throw permissionRefused();
    const copy = await duplicateRecipe(scope, id);
    return NextResponse.json(
      { recipe: recipePayload(await readRecipe(scope, copy.id)) },
      { status: 201, headers: { Location: `/api/recipes/${copy.id}` } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

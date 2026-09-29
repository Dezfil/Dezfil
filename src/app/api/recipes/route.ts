import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { createRecipe, listRecipes } from "@/lib/metadata/owned-recipes";
import { metadataDb } from "@/lib/metadata/db";
import { fileRecipe } from "@/lib/metadata/owned-recipes";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { importProjectId, projectScope } from "@/lib/project-scope";
import { readRecipe } from "@/lib/operations/recipe-view";
import {
  jsonBody,
  recipeName,
  recipeOrigin,
  recipePayload,
} from "@/lib/operations/recipe-api";

/**
 * Recipes.
 *
 * **A workspace object, like a dataset** — not owned by a map, and surviving
 * the deletion of the layer that prompted it. That is why this lives at the top
 * level rather than under `/api/maps/{id}`.
 */
export async function GET(request: Request) {
  try {
    const scope = requireRequestScope(request);
    // `?origin=workflow` is how the workflows page asks for its own;
    // unfiltered, both origins answer within the account.
    const origin = new URL(request.url).searchParams.get("origin");
    if (origin !== null && origin !== "workflow" && origin !== "builder") {
      throw new ApiError(
        "invalid_request",
        '"origin" must be "workflow" or "builder" when given.',
        400,
      );
    }
    // `?project=` composes with origin; an unknown project answers not
    // found, never an empty list.
    const project = projectScope(request);
    if (project && project !== "none") requireOwnedResource(scope, "project", project);
    const recipes = await Promise.all(
      listRecipes(scope, undefined, {
        ...(origin ? { origin } : {}),
        ...(project ? { project } : {}),
      }).map(async (r) => recipePayload(await readRecipe(scope, r.id))),
    );
    return NextResponse.json({ recipes });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const body = await jsonBody(request);
    // Optionally filed at birth: an unknown project refuses and creates
    // nothing.
    const projectId = importProjectId(body.projectId);
    if (projectId) requireOwnedResource(scope, "project", projectId);
    const recipe = metadataDb().transaction(() => {
      const created = createRecipe(scope, recipeName(body), undefined, recipeOrigin(body));
      if (projectId) fileRecipe(scope, created.id, projectId);
      return created;
    })();
    return NextResponse.json(
      { recipe: recipePayload(await readRecipe(scope, recipe.id)) },
      { status: 201, headers: { Location: `/api/recipes/${recipe.id}` } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

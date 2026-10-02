import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";
import { requireDocumentRevision } from "@/lib/metadata/revisions";
import { revisionEnvelope } from "@/lib/metadata/document-results";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireWorkflowEdit } from "@/lib/workflow-access";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { deleteRecipe, renameRecipe } from "@/lib/metadata/owned-recipes";
import { requirePermitted } from "@/lib/auth/reach";
import { readRecipe } from "@/lib/operations/recipe-view";
import { jsonBody, recipeName, recipePayload } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(revisionEnvelope("recipe", recipePayload(await readRecipe(scope, id))));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    requireWorkflowEdit(scope, id);
    const options = { expectedRevision: request.headers.get(EDIT_REVISION_HEADER) };
    requireDocumentRevision(scope, { kind: "workflow", id, ...options });
    const body = await jsonBody(request);
    if (!renameRecipe(scope, id, recipeName(body), undefined, options)) {
      throw resourceAbsent();
    }
    return NextResponse.json(revisionEnvelope("recipe", recipePayload(await readRecipe(scope, id))));
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
    const scope = requireRequestScope(_request);
    const { id } = await params;
    // Deleting a workflow is its owner's act.
    requirePermitted(scope, "workflow", id, "delete");
    if (!deleteRecipe(scope, id, undefined, { expectedRevision: _request.headers.get(EDIT_REVISION_HEADER) })) {
      throw resourceAbsent();
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

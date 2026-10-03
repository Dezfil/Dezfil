import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";
import { requireDocumentRevision } from "@/lib/metadata/revisions";
import { revisionEnvelope } from "@/lib/metadata/document-results";
import { resourceAbsent } from "@/lib/auth/owned-resource";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireWorkflowEdit } from "@/lib/workflow-access";
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
    requireWorkflowEdit(scope, id, stepId);
    const options = { expectedRevision: _request.headers.get(EDIT_REVISION_HEADER) };
    requireDocumentRevision(scope, { kind: "workflow", id, ...options });
    const step = getStep(scope, stepId);
    if (!step || step.recipeId !== id) {
      throw resourceAbsent();
    }
    const discarded = step.proposedParameters !== null;
    discardProposal(scope, stepId, undefined, options);
    return NextResponse.json({
      ...revisionEnvelope("step", stepPayload(await readStep(scope, id, stepId))),
      discarded,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

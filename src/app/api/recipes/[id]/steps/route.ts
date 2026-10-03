import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";
import { requireDocumentRevision } from "@/lib/metadata/revisions";
import { revisionEnvelope } from "@/lib/metadata/document-results";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireWorkflowEdit } from "@/lib/workflow-access";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import {
  addStep,
  listSteps,
  touchRecipe,
  type RecipeStep,
} from "@/lib/metadata/owned-recipes";
import { findOperation } from "@/lib/operations/catalog";
import { outputNameRefusal, registeredOutputName } from "@/lib/operations/output-names";
import { assertBackwardOnly } from "@/lib/operations/recipe-order";
import { readStep } from "@/lib/operations/recipe-view";
import { stepReads } from "@/lib/operations/step-reads";
import { admitStepDefinition, recheckSaved } from "@/lib/save-admission";
import {
  jsonBody,
  requireString,
  stepPayload,
} from "@/lib/operations/recipe-api";
import { arrivingDefinition } from "@/lib/operations/step-handoff";

type Params = { params: Promise<{ id: string }> };

/**
 * Add a step.
 *
 * **`fromLayerId` captures, it does not link.** The layer's SQL refined by its
 * filters is copied in at this moment and never re-read: a step whose meaning
 * drifted when someone edited a filter would not be reproducible. Where the
 * layer aggregates — hex bin, grid, origin–destination — the step takes the
 * rows behind the cells, and the answer says so rather than leaving the
 * substitution to be discovered. Any layer the caller reaches can be
 * captured; its SQL is carried from the map's home into this workflow's.
 *
 * **The backward-only rule is enforced here, at the change.** A step that would
 * read its own output, or a later step's, is refused now rather than at run
 * time, when a user has long since stopped thinking about it.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    requireWorkflowEdit(scope, id);
    const options = { expectedRevision: request.headers.get(EDIT_REVISION_HEADER) };
    requireDocumentRevision(scope, { kind: "workflow", id, ...options });
    const body = await jsonBody(request);
    const operation = findOperation(requireString(body, "operation"));
    const parameters =
      typeof body.parameters === "object" &&
      body.parameters !== null &&
      !Array.isArray(body.parameters)
        ? { ...(body.parameters as Record<string, unknown>) }
        : {};

    // A definition written elsewhere (another workflow's node, the console,
    // a map) and a captured layer's SQL are carried into this workflow's
    // context, their references keeping the datasets they meant.
    const arriving = await arrivingDefinition(scope, id, operation.id, parameters, body, request.signal);
    Object.assign(parameters, arriving.parameters);
    const origin: Record<string, unknown> | null = arriving.origin ?? null;

    // Someone other than the workflow's owner saves only what they can
    // evaluate themselves: every dataset it names within their reach in the
    // workflow's home, its declared outputs exempt.
    const saved = await admitStepDefinition(scope, id, operation.id, parameters, request.signal);
    const db = metadataDb();
    // The name rule: refused in its own words, or stored in its
    // registered form.
    const refusal = outputNameRefusal({ scope, db, recipeId: id, stepId: null, produced: null, typed: parameters.name });
    if (refusal) throw refusal;
    if (typeof parameters.name === "string") parameters.name = registeredOutputName(parameters.name);
    const existing = listSteps(scope, id, db);
    // What the new step would read, resolved before anything is written:
    // the backward-only rule is enforced at the change, not at the run.
    const pending = {
      id: "pending",
      recipeId: id,
      ordinal: existing.length,
      operation: operation.id,
      parameters,
      proposedParameters: null,
      outputTableId: null,
      outputTableName: null,
      origin,
      proposedOrigin: null,
      lastSuccessAt: null,
      createdAt: "",
      updatedAt: "",
    } satisfies RecipeStep;
    // SQL the parser cannot read is accepted with no reads; the dry run
    // and the run refuse it and say why.
    const reads = await stepReads(scope, pending).catch(() => [] as string[]);
    assertBackwardOnly([...existing, pending], { stepId: pending.id, ordinal: pending.ordinal, reads });
    // Committed only if nothing moved under the checks — another edit may
    // have claimed the name or changed the order meanwhile.
    const step = db.transaction(() => {
      requireDocumentRevision(scope, { kind: "workflow", id, ...options }, db);
      const again = outputNameRefusal({ scope, db, recipeId: id, stepId: null, produced: null, typed: parameters.name });
      if (again) throw again;
      recheckSaved(scope, saved);
      const added = addStep(scope, id, { operation: operation.id, parameters, origin }, db, options);
      // Accepted, so the recipe is edited.
      touchRecipe(scope, id, db);
      return added;
    })();
    return NextResponse.json(
      revisionEnvelope("step", stepPayload(await readStep(scope, id, step.id))),
      {
        status: 201,
        headers: { Location: `/api/recipes/${id}/steps/${step.id}` },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

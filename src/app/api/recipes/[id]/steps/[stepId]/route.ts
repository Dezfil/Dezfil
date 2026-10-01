import { requireStep } from "@/lib/metadata/owned-recipes";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireWorkflowEdit } from "@/lib/workflow-access";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { metadataDb } from "@/lib/metadata/db";
import {
  editStep,
  listSteps,
  removeStep,
  reorderSteps,
  type RecipeStep,
} from "@/lib/metadata/owned-recipes";
import { outputNameRefusal, registeredOutputName } from "@/lib/operations/output-names";
import {
  assertBackwardOnly,
  assertOrderingValid,
  dependenciesWithin,
  orderAfterProducers, tolerantReadsByStep } from "@/lib/operations/recipe-order";
import { readStep } from "@/lib/operations/recipe-view";
import { stepReads } from "@/lib/operations/step-reads";
import { recipeStanding } from "@/lib/metadata/owned-recipes";
import { reachableDatasetIds } from "@/lib/auth/reach";
import { linkFilter } from "@/lib/operations/output-links";
import { findOperation } from "@/lib/operations/catalog";
import {
  captureLayerSource,
  jsonBody,
  stepPayload,
} from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string; stepId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id, stepId } = await params;
    requireStep(scope, id, stepId);
    return NextResponse.json({ step: stepPayload(await readStep(scope, id, stepId)) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Edit a step.
 *
 * **A change to a step that has already produced something is a proposal.**
 * The step keeps meaning what its output was produced from until a run of the
 * proposal succeeds; the answer says which of the two happened, because the
 * caller's next move differs.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, stepId } = await params;
    requireWorkflowEdit(scope, id, stepId);
    const step = requireStep(scope, id, stepId);
    const body = await jsonBody(request);

    const parameters =
      typeof body.parameters === "object" &&
      body.parameters !== null &&
      !Array.isArray(body.parameters)
        ? { ...(body.parameters as Record<string, unknown>) }
        : { ...step.parameters };
    // Re-authoring from a layer brings its origin with it, and that origin is
    // promoted with the definition rather than at once: until the proposal
    // succeeds the step still means what its output was produced from, and its
    // origin must go on describing *that*.
    let origin: Record<string, unknown> | undefined;
    if (typeof body.fromLayerId === "string" && body.fromLayerId !== "") {
      const captured = captureLayerSource(scope, body.fromLayerId);
      parameters.sql = captured.sql;
      origin = captured.origin;
    }

    const db = metadataDb();
    // The name rule: a produced output keeps its name; otherwise refused
    // in its own words, or stored registered.
    const refusal = outputNameRefusal({ scope,
      db,
      recipeId: id,
      stepId: step.id,
      produced: step.outputTableName,
      typed: parameters.name,
    });
    if (refusal) throw refusal;
    if (typeof parameters.name === "string") parameters.name = registeredOutputName(parameters.name);
    const steps = listSteps(scope, id, db);
    const stamp = (list: RecipeStep[]) => list.map((s) => `${s.id}:${s.ordinal}:${s.updatedAt}`).join("|");
    const before = stamp(steps);
    // What the step would read next. SQL the parser cannot read is accepted
    // here with no reads: the canvas saves what is typed, and the dry run
    // and the run refuse it and say why.
    const reads = await stepReads(scope, { operation: step.operation, parameters, proposedParameters: null }).catch(
      () => [] as string[],
    );
    // A read of a producer that stands later is not refused but ordered:
    // the reader and its dependents move after the producer, unrelated
    // steps keep their places, and the whole order is checked; a self-read
    // is still refused. The edit and the order land together or not at all.
    const later = dependenciesWithin(steps, reads).filter((d) => d.id !== step.id && d.ordinal >= step.ordinal);
    let order: string[] | null = null;
    if (later.length > 0) {
      const readsOf = await tolerantReadsByStep(steps.filter((s) => s.id !== step.id), step => stepReads(scope, step));
      readsOf.set(step.id, reads);
      const proposed = orderAfterProducers(steps, step.id, later.map((d) => d.id), readsOf);
      assertOrderingValid(proposed, readsOf);
      order = proposed.map((s) => s.id);
    } else {
      assertBackwardOnly(steps, { stepId: step.id, ordinal: step.ordinal, reads });
    }
    // Committed only if nothing moved under the checks.
    const landed = db.transaction(() => {
      if (stamp(listSteps(scope, id, db)) !== before) {
        throw new ApiError("invalid_request", "This workflow changed while the edit was being checked. Try again.", 409);
      }
      const again = outputNameRefusal({ scope, db, recipeId: id, stepId: step.id, produced: step.outputTableName, typed: parameters.name });
      if (again) throw again;
      const applied = editStep(scope, stepId, parameters, db, origin);
      if (order) reorderSteps(scope, id, order, db);
      return applied;
    })();
    return NextResponse.json({
      step: stepPayload(await readStep(scope, id, stepId)),
      // "active" changed what the step means; "proposed" is waiting on a run.
      applied: landed,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Remove a step.
 *
 * It detaches: the dataset it produced and its run history both survive, and
 * a step that reads that dataset goes on reading it as an ordinary workspace
 * table. **The answer says what is true**, from the recorded dataset's
 * identity rather than its name: the dataset exists and stays; it was
 * produced but has since been deleted; or the step never produced one — and
 * which nodes read its output, by name, today.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id, stepId } = await params;
    requireWorkflowEdit(scope, id, stepId);
    const step = requireStep(scope, id, stepId);
    const steps = listSteps(scope, id);
    // The output as its remover may see it: one they reach exists; one gone
    // is told as gone only to the workflow's owner, whose record it is; one
    // out of their reach is not named at all.
    const recorded = step.outputTableId !== null
      ? { id: step.outputTableId, name: step.outputTableName ?? "" } : null;
    const visible = recorded ? linkFilter(scope, [recipeStanding(id)?.ownerId ?? null])(recorded) : null;
    const exists = visible !== null && reachableDatasetIds(scope).has(visible.id);
    const state: "exists" | "deleted" | "never" =
      step.outputTableId === null || (recorded !== null && visible === null) ? "never" : exists ? "exists" : "deleted";
    const declared =
      step.outputTableName?.toLowerCase() ??
      (typeof step.parameters.name === "string" && step.parameters.name !== ""
        ? registeredOutputName(step.parameters.name)
        : null);
    const reads = await tolerantReadsByStep(steps.filter((s) => s.id !== stepId), step => stepReads(scope, step));
    const readers = steps
      .filter((s) => s.id !== stepId && declared !== null && (reads.get(s.id) ?? []).includes(declared))
      .map((s) => ({ id: s.id, operation: s.operation, label: findOperation(s.operation).label }));
    removeStep(scope, stepId);
    const name = recorded !== null && visible === null ? null : step.outputTableName ?? (declared ? declared : null);
    const message = recorded !== null && visible === null
      ? "The step was removed."
      : state === "exists"
        ? `The step was removed. The dataset "${name}" it produced remains, and its run history is still readable.` +
          (readers.length ? ` ${readers.length === 1 ? "One node reads" : `${readers.length} nodes read`} it as a workspace table now.` : "")
        : state === "deleted"
          ? `The step was removed. The dataset "${name}" it once produced had already been deleted.` +
            (readers.length ? ` ${readers.length === 1 ? "One node still reads" : `${readers.length} nodes still read`} that name, which nothing produces.` : "")
          : "The step was removed. It had not produced a dataset." +
            (readers.length && name ? ` ${readers.length === 1 ? "One node reads" : `${readers.length} nodes read`} "${name}", which nothing produces now.` : "");
    return NextResponse.json({
      removed: stepId,
      output: name ? { name, state } : null,
      readers,
      outputsRemain: state === "exists",
      message,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

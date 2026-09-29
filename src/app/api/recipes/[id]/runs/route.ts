import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { listCascades } from "@/lib/metadata/owned-cascades";
import { planCascade, readCascade, startCascade } from "@/lib/operations/cascade";
import { cascadePayload, optionalJsonBody } from "@/lib/operations/recipe-api";

type Params = { params: Promise<{ id: string }> };

/** A recipe's own runs, newest first — each one durable, and readable long
 * after it finished. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json({
      runs: listCascades(scope, id).map((c) => cascadePayload(readCascade(scope, c.id))),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Run a recipe, or a step and everything that reads it.
 *
 * Omit `fromStepId` to run the whole recipe from the beginning; give one to
 * re-run that step and its dependents, in dependency order.
 *
 * **Ask first with `plan`.** The confirmation this operation declares follows
 * the blast radius, and `plan: true` answers what it would carry without
 * starting anything: `wide` is true for a run of the whole recipe and for a
 * re-run that carries dependents, and false for the same request aimed at a
 * step nothing reads.
 *
 * A cascade is **not a job**: it answers **202** with its own resource, which
 * has its own outcome and contains the members' ordinary runs.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    // **Absent is not the same as malformed here, and conflating them is not a
    // tidiness question.** On this endpoint an absent body means *run the whole
    // recipe*, so treating a truncated payload or a mistyped field as absent
    // would turn a narrow re-run into a run of everything — the exact blast
    // radius this operation's confirmation exists to bound. An empty body
    // selects run-all; anything present and wrong is refused.
    const body = await optionalJsonBody(request);
    if (body.fromStepId !== undefined && typeof body.fromStepId !== "string") {
      throw new ApiError(
        "invalid_request",
        `"fromStepId" must be the id of a step in this recipe.`,
        400,
      );
    }
    const fromStepId =
      typeof body.fromStepId === "string" && body.fromStepId !== ""
        ? body.fromStepId
        : undefined;
    // The confirmed membership: the ids a confirmation listed, in order;
    // the run starts only when the plan at start is that.
    if (
      body.members !== undefined &&
      (!Array.isArray(body.members) || body.members.some((m) => typeof m !== "string" || m === ""))
    ) {
      throw new ApiError("invalid_request", `"members" must be the confirmed step ids, in order.`, 400);
    }
    const members = Array.isArray(body.members) ? (body.members as string[]) : undefined;

    if (body.plan === true) {
      const plan = await planCascade(scope, {
        recipeId: id,
        ...(fromStepId ? { fromStepId } : {}),
      });
      return NextResponse.json({
        plan: {
          kind: plan.kind,
          wide: plan.wide,
          members: plan.members.map((m) => m.stepId),
        },
      });
    }

    const cascade = await startCascade(scope, {
      recipeId: id,
      ...(fromStepId ? { fromStepId } : {}),
      ...(members ? { members } : {}),
    });
    return NextResponse.json(
      { run: cascadePayload(readCascade(scope, cascade.id)) },
      {
        status: 202,
        headers: { Location: `/api/recipes/${id}/runs/${cascade.id}` },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

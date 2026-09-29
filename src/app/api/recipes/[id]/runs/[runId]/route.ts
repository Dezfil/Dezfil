import { requireOwnedResource, resourceAbsent } from "@/lib/auth/owned-resource";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
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
    const scope = requireRequestScope(_request);
    const { id, runId } = await params;
    requireOwnedResource(scope, "workflow", id);
    const cascade = readCascade(scope, runId);
    if (cascade.recipeId !== id) {
      throw resourceAbsent();
    }
    return NextResponse.json({ run: cascadePayload(cascade) });
  } catch (error) {
    return errorResponse(error);
  }
}

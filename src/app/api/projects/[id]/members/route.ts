import { requireRequestScope } from "@/lib/auth/scope-http";
import { canReach } from "@/lib/auth/reach";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { changeMembers } from "@/lib/metadata/owned-projects";
import { memberChange, projectMembers } from "@/lib/project-service";

type Params = { params: Promise<{ id: string }> };

/** The composite members read: the project's maps, recipes and datasets,
 * each in its ordinary listing shape and order. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(await projectMembers(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** One atomic filing change: adds and removes for maps, recipes and
 * datasets together, each by the filing rules, all applied or none.
 * Answers the updated composite as the caller reads it: empty for an owner
 * who withdrew their own resources from a project they no longer reach. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const change = memberChange(body);
    changeMembers(scope, id, change);
    return NextResponse.json(canReach(scope, "project", id)
      ? await projectMembers(scope, id) : { maps: [], recipes: [], tables: [] });
  } catch (error) {
    return errorResponse(error);
  }
}

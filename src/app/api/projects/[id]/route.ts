import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import {
  deleteProject,
  requireProject,
  updateProject,
} from "@/lib/metadata/projects";
import { projectOverview } from "@/lib/project-service";

type Params = { params: Promise<{ id: string }> };

/** Read one project with its member counts and size. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(await projectOverview(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Rename a project or edit its note. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("invalid_request", "Expected a JSON object body.", 400);
    }
    const body = parsed as Record<string, unknown>;
    updateProject(id, { name: body.name, note: body.note });
    return NextResponse.json(await projectOverview(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete a project: the set dissolves; every member and artifact stays.
 * The disclosure mirrors the recipe-deletion precedent, because this too
 * is a deletion that leaves things behind. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    requireProject(id);
    deleteProject(id);
    return NextResponse.json({
      deleted: true,
      contentsRemain: true,
      message:
        "The project dissolved. Its maps, workflows and datasets remain, " +
        "now unfiled unless another project holds them.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

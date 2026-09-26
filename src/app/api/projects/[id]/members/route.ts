import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { changeMembers } from "@/lib/metadata/projects";
import { memberChange, projectMembers } from "@/lib/project-service";

type Params = { params: Promise<{ id: string }> };

/** The composite members read: the project's maps, recipes and datasets,
 * each in its ordinary listing shape and order. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json(await projectMembers(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** One atomic membership change: adds and removes
 * for maps, recipes and datasets together — all applied or none. Answers
 * the updated composite. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    changeMembers(id, memberChange(body));
    return NextResponse.json(await projectMembers(id));
  } catch (error) {
    return errorResponse(error);
  }
}

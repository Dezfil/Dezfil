import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { createProject } from "@/lib/metadata/projects";
import {
  memberChange,
  projectOverview,
  projectsOverview,
} from "@/lib/project-service";

/**
 * Projects: the optional named set over maps, workflows and datasets.
 * Bare-object responses, the maps convention.
 */

/** List projects, each with its member counts and size. */
export async function GET() {
  try {
    return NextResponse.json(await projectsOverview());
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create a project — optionally filing initial members in the same act
 * (the 14-A New-project gesture): one invalid member creates nothing. */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const created = createProject(scope, {
      name: body.name,
      note: body.note,
      members: body.members === undefined ? undefined : memberChange(body.members),
    });
    return NextResponse.json(await projectOverview(created.id), {
      status: 201,
      headers: { Location: `/api/projects/${created.id}` },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

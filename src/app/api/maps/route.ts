import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { createMap, mapsOverview } from "@/lib/map-service";
import { metadataDb } from "@/lib/metadata/db";
import { fileMap, mapProjectId, requireProject } from "@/lib/metadata/projects";
import { importProjectId, projectScope } from "@/lib/project-scope";

/** List all maps, each with its layer count and colors.
 * `?project=<id>` narrows to that project's, `?project=none` to the
 * unfiled; an unknown project answers not found. */
export async function GET(request: Request) {
  try {
    return NextResponse.json(mapsOverview(projectScope(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create a map — optionally filed into a project at birth:
 * an unknown project refuses and creates nothing. */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    let name = "Untitled map";
    let projectId: string | null = null;
    try {
      const body = (await request.json()) as {
        name?: unknown;
        projectId?: unknown;
      };
      if (typeof body.name === "string") name = body.name;
      else if (body.name !== undefined) {
        throw new ApiError("invalid_request", "name must be a string.", 400);
      }
      projectId = importProjectId(body.projectId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Empty body is fine — a default-named, unfiled map.
    }
    if (projectId) requireProject(projectId);
    const map = metadataDb().transaction(() => {
      const created = createMap(scope, name);
      if (projectId) fileMap(created.id, projectId);
      return created;
    })();
    return NextResponse.json(
      { ...map, projectId: mapProjectId(map.id) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

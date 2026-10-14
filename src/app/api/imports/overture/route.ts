import { largeJsonValue } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireFilingDestination } from "@/lib/auth/reach";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { importOverture } from "@/lib/overture/import";
import { importProjectId } from "@/lib/project-scope";

/** Import an Overture Maps slice as a table. */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const body = (await largeJsonValue(request, () => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      throw new ApiError(
        "invalid_request",
        "Expected a JSON body with theme and a scope (or legacy bbox).",
        400,
      );
    }
    // Preflight: an unknown project refuses before any source is
    // contacted.
    const projectId = importProjectId(body.projectId);
    if (projectId) requireFilingDestination(scope, projectId);
    const table = await importOverture(scope, {
      theme: body.theme,
      scope: body.scope,
      semantics: body.semantics,
      level: body.level,
      bbox: body.bbox,
      release: body.release,
      category: body.category,
      name: body.name,
      projectId,
    }, undefined, request.signal);
    return NextResponse.json(
      { ...table, projectIds: projectId ? [projectId] : [] },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

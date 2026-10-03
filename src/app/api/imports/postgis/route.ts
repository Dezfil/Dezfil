import { largeJsonValue } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireFilingDestination } from "@/lib/auth/reach";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { importPostgis } from "@/lib/postgis/import";
import { importProjectId } from "@/lib/project-scope";

/** Import a PostGIS table as a GeoParquet snapshot. */
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
        "Expected a JSON body with connectionId, schema, and table.",
        400,
      );
    }
    // Preflight: an unknown project refuses before any source is
    // contacted.
    const projectId = importProjectId(body.projectId);
    if (projectId) requireFilingDestination(scope, projectId);
    const table = await importPostgis(scope, {
      connectionId: body.connectionId,
      schema: body.schema,
      table: body.table,
      name: body.name,
      filter: body.filter,
      limit: body.limit,
      projectId,
    });
    return NextResponse.json(
      { ...table, projectIds: projectId ? [projectId] : [] },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

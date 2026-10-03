import { largeJsonValue } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireFilingDestination } from "@/lib/auth/reach";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { importOsm } from "@/lib/osm/import";
import { importProjectId } from "@/lib/project-scope";

/** Import OpenStreetMap data via Overpass as tables. */
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
        "Expected a JSON body with selectors + bbox, or a raw ql query.",
        400,
      );
    }
    // Preflight: an unknown project refuses before any source is
    // contacted.
    const projectId = importProjectId(body.projectId);
    if (projectId) requireFilingDestination(scope, projectId);
    const tables = await importOsm(scope, {
      selectors: body.selectors,
      ql: body.ql,
      bbox: body.bbox,
      ring: body.ring,
      geometry: body.geometry,
      semantics: body.semantics,
      name: body.name,
      projectId,
    });
    return NextResponse.json(
      {
        tables: tables.map((t) => ({
          ...t,
          projectIds: projectId ? [projectId] : [],
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

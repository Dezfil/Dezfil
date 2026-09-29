import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/lib/api/errors";
import { importFromUrl } from "@/lib/ingest/remote";
import { requireProject } from "@/lib/metadata/projects";
import { importProjectId } from "@/lib/project-scope";
import { toIngestResponse } from "@/lib/ingest/gdal-formats";

/** Import a remote file (https/s3/gs/az) as a table (From URL). */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      name?: unknown;
    } | null;
    if (!body || typeof body.url !== "string") {
      throw new ApiError(
        "invalid_request",
        'Expected a JSON body with a "url" string field.',
        400,
      );
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      throw new ApiError(
        "invalid_request",
        'The optional "name" field must be a string.',
        400,
      );
    }
    // Preflight: an unknown project refuses before the remote source is
    // contacted.
    const projectId = importProjectId((body as { projectId?: unknown }).projectId);
    if (projectId) requireProject(projectId);
    const result = await importFromUrl(scope, body.url, body.name, projectId);
    const filed = {
      ...result,
      tables: result.tables.map((t) => ({
        ...t,
        projectIds: projectId ? [projectId] : [],
      })),
    };
    return NextResponse.json(toIngestResponse(filed), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireProject } from "@/lib/metadata/projects";
import { receiveUpload } from "@/lib/ingest/receive";
import { ingestSource, toIngestResponse } from "@/lib/ingest/gdal-formats";
import { listTablesWithSize } from "@/lib/table-service";
import { projectScope } from "@/lib/project-scope";

/** List all tables, each with its artifact's size on disk.
 * `?project=<id>` narrows to that project's datasets, `?project=none` to
 * the unfiled; an unknown project answers not found. */
export async function GET(request: Request) {
  try {
    return NextResponse.json(await listTablesWithSize(projectScope(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Upload a file; it becomes one or more queryable tables (spec: Upload;
 * container formats land one table per spatial layer). */
export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    // Preflight: an unknown project refuses before the upload is even
    // received.
    const projectId = projectScope(request);
    if (projectId === "none") {
      throw new ApiError(
        "invalid_request",
        '"project" must be a project id on an upload.',
        400,
      );
    }
    if (projectId) requireProject(projectId);
    const { tmpPath, filename } = await receiveUpload(request);
    try {
      const result = await ingestSource(scope, tmpPath, filename, {
        source: "upload",
        sourceParams: null,
        projectId: projectId ?? null,
      });
      const filed = {
        ...result,
        tables: result.tables.map((t) => ({
          ...t,
          projectIds: projectId ? [projectId] : [],
        })),
      };
      return NextResponse.json(toIngestResponse(filed), { status: 201 });
    } finally {
      await rm(tmpPath, { force: true });
    }
  } catch (error) {
    return errorResponse(error);
  }
}

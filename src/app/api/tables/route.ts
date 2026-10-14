import { removeAccountFile } from "@/lib/ingest/file-ownership";
import { withRouteGate, gateOnly, gateHead } from "@/lib/auth/route-gate";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireFilingDestination } from "@/lib/auth/reach";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { receiveUpload } from "@/lib/ingest/receive";
import { ingestSource, toIngestResponse } from "@/lib/ingest/gdal-formats";
import { listTablesWithSize } from "@/lib/table-service";
import { projectScope } from "@/lib/project-scope";

/** List all tables, each with its artifact's size on disk.
 * `?project=<id>` narrows to that project's datasets, `?project=none` to
 * the unfiled; an unknown project answers not found. */
async function list(request: Request) {
  try {
    const scope = requireRequestScope(request);
    return NextResponse.json(await listTablesWithSize(scope, projectScope(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Upload a file; it becomes one or more queryable tables (spec: Upload;
 * container formats land one table per spatial layer). */
async function upload(request: Request) {
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
    if (projectId) requireFilingDestination(scope, projectId);
    const { tmpPath, filename, budget } = await receiveUpload(request, scope.accountId);
    try {
      const result = await ingestSource(scope, tmpPath, filename, {
        source: "upload",
        sourceParams: null,
        projectId: projectId ?? null,
      }, undefined, budget, request.signal);
      const filed = {
        ...result,
        tables: result.tables.map((t) => ({
          ...t,
          projectIds: projectId ? [projectId] : [],
        })),
      };
      return NextResponse.json(toIngestResponse(filed), { status: 201 });
    } finally {
      await removeAccountFile(tmpPath, { force: true });
    }
  } catch (error) {
    return errorResponse(error);
  }
}

// These named exports keep every framework-dispatchable method behind the gate.
export async function GET(request: Request) { return withRouteGate(request, () => list(request)); }
export async function POST(request: Request) { return withRouteGate(request, () => upload(request)); }
export async function HEAD(request: Request) { return gateHead(request, GET); }
export async function OPTIONS(request: Request) { return gateOnly(request); }
export async function PUT(request: Request) { return gateOnly(request); }
export async function DELETE(request: Request) { return gateOnly(request); }
export async function PATCH(request: Request) { return gateOnly(request); }

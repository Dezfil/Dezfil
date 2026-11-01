import { withStorageRecovery } from "@/lib/system/storage-reserve";
import { largeJsonValue } from "@/lib/api/json-body";
import { metadataDb } from "@/lib/metadata/db";
import { filedDocuments } from "@/lib/metadata/filing-recording";
import { documentResults } from "@/lib/metadata/document-results";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import {
  deleteProject,
  updateProject,
} from "@/lib/metadata/owned-projects";
import { requirePermitted } from "@/lib/auth/reach";
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
      parsed = await largeJsonValue(request);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError("invalid_request", "Expected a JSON object body.", 400);
    }
    const body = parsed as Record<string, unknown>;
    updateProject(scope, id, { name: body.name, note: body.note });
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
    const scope = requireRequestScope(_request);
    const { id } = await params;
    requirePermitted(scope, "project", id, "dissolve");
    const revisions = await withStorageRecovery(() => metadataDb().transaction(() => {
      const documents = filedDocuments(id, metadataDb());
      deleteProject(scope, id);
      return documentResults(scope, documents);
    })());
    return NextResponse.json({
      revisions,
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

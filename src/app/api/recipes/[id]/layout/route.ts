import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";
import { revisionEnvelope } from "@/lib/metadata/document-results";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { jsonBody } from "@/lib/operations/recipe-api";
import { layoutPayload, readLayout, writeLayout } from "@/lib/operations/recipe-layout";

type Params = { params: Promise<{ id: string }> };

/**
 * The canvas layout document: positions for the recipe's nodes and
 * sources, and its notes, beside the recipe and never inside it. Read
 * whole; replaced whole. Nothing here reaches the recipe's steps.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(revisionEnvelope("layout", layoutPayload(readLayout(scope, id))));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const body = await jsonBody(request);
    return NextResponse.json(revisionEnvelope("layout", layoutPayload(writeLayout(scope, id, body, undefined, { expectedRevision: request.headers.get(EDIT_REVISION_HEADER) }))));
  } catch (error) {
    return errorResponse(error);
  }
}

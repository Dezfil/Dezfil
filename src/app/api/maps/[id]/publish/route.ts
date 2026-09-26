import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { parsePublishBody } from "@/lib/publish/publish-body";
import {
  getPublicationState,
  publishMap,
  unpublishMap,
} from "@/lib/publish/publish-service";

type Params = { params: Promise<{ id: string }> };

/** The active publication's authored settings — the theme
 * default and the viewer-controls checklist. 204 when the map is not
 * published: there is no publication to describe, which is a state, not
 * an error. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const state = getPublicationState(id);
    return state
      ? NextResponse.json(state)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Publish a map; returns its stable token. Idempotent while published —
 * a stated theme or a stated viewer-controls set on an active publication
 * updates that setting in place without changing the token. An omitted
 * setting changes nothing. */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const settings = await parsePublishBody(request);
    return NextResponse.json(publishMap(id, settings), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Unpublish a map; the link stops resolving immediately. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    unpublishMap(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

import { privateResponse } from "@/lib/auth/http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { getPublishedView } from "@/lib/publish/publish-service";
import { admitPublishedRequest } from "@/lib/publish/source-admission";

type Params = { params: Promise<{ token: string }> };

/**
 * The read-only published view for a token (spec: Publish). This is the only
 * data path a published page uses; it reads and renders, never mutates. An
 * unknown token yields a clean not-found, never internals.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { token } = await params;

    admitPublishedRequest(request);

    const view = await getPublishedView(token, Date.now(), request.signal);
    if (!view) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }
    return NextResponse.json(view, {
      headers: {
        // Authorization is the current token row, so a stored JSON response
        // must never bypass origin after unpublish or deletion.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return privateResponse(errorResponse(error));
  }
}

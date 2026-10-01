import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { duplicateMap } from "@/lib/map-service";
import { mapPresence } from "@/lib/reach-presence";
import { copyThumbnail } from "@/lib/map-thumbnails";

type Params = { params: Promise<{ id: string }> };

/** Duplicate a map with all its layers — an unpublished draft. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    const copy = duplicateMap(scope, id);
    // The copy keeps the original's snapshot until its own first capture.
    await copyThumbnail(scope, id, copy.id);
    return NextResponse.json(
      { ...copy, ...mapPresence(scope, copy.id) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

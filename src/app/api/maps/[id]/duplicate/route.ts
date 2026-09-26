import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { duplicateMap } from "@/lib/map-service";
import { mapProjectId } from "@/lib/metadata/projects";
import { copyThumbnail } from "@/lib/map-thumbnails";

type Params = { params: Promise<{ id: string }> };

/** Duplicate a map with all its layers — an unpublished draft. */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const copy = duplicateMap(id);
    // The copy keeps the original's snapshot until its own first capture.
    await copyThumbnail(id, copy.id);
    return NextResponse.json(
      { ...copy, projectId: mapProjectId(copy.id) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { cascadeDeleteSketch } from "@/lib/sketch/store";

type Params = { params: Promise<{ name: string }> };

/**
 * The owning-layer cascade: the provenance-named owner, its bound
 * widgets, the dataset, the artifact and the tile artifacts leave
 * together. Deliberately not undoable — no history step is written and
 * owner-targeting steps leave the timeline.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { name } = await params;
    await cascadeDeleteSketch(name);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

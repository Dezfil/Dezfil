import { NextResponse } from "next/server";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireMapFor } from "@/lib/map-access";
import { errorResponse } from "@/lib/api/errors";
import { activePictureService, startPictures } from "@/lib/pictures/start";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = requireRequestScope(request), { id } = await params;
    requireMapFor(scope, id, "edit");
    if (!activePictureService()) startPictures();
    const state = await activePictureService()!.refresh(id);
    // Authority may change during dependency resolution, before the answer.
    requireMapFor(scope, id, "edit");
    const unavailable = state.state === "unavailable";
    return NextResponse.json({ outcome: unavailable ? "unavailable" : "queued", pictureState: state.state }, { status: unavailable ? 200 : 202 });
  } catch (error) { return errorResponse(error); }
}

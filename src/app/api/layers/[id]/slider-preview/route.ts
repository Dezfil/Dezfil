import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireLayer, sliderPreviewData } from "@/lib/layer-service";

type Params = { params: Promise<{ id: string }> };

/** Read-only bounded point input for responsive builder slider previews. */
export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json(
      await sliderPreviewData(requireLayer(id), request.signal),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

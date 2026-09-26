import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { assertPreviewActive } from "@/lib/postgis/preview-owner";
import { previewPostgis } from "@/lib/postgis/preview";

type Params = { params: Promise<{ id: string }> };

/** Preview one saved source relation through the guarded import SELECT. */
export async function POST(request: Request, { params }: Params) {
  try {
    assertPreviewActive(request.signal);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await previewPostgis(id, body, undefined, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}

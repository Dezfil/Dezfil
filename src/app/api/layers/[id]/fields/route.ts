import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireLayer, layerFields } from "@/lib/layer-service";

type Params = { params: Promise<{ id: string }> };

/** The layer's non-geometry columns, for choosing a fill attribute. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const layer = requireLayer(scope, id);
    return NextResponse.json(await layerFields(layer, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}

import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireLayer, layerFieldStats } from "@/lib/layer-service";

type Params = { params: Promise<{ id: string; field: string }> };

/** Seed data for a filter control: a field's extent or distinct values. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, field } = await params;
    const layer = requireLayer(scope, id);
    return NextResponse.json(
      await layerFieldStats(scope, layer, field, request.signal),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

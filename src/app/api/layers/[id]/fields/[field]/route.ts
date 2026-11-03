import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireLayer, layerFieldStats } from "@/lib/layer-service";
import { classificationDistribution } from "@/lib/classification-distribution";

type Params = { params: Promise<{ id: string; field: string }> };

/** Seed data for a filter control: a field's extent or distinct values;
 * with `distribution=classification`, the distribution a classification
 * of the field sees, for the classed histogram. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id, field } = await params;
    const layer = requireLayer(scope, id);
    const distribution = new URL(request.url).searchParams.get("distribution");
    if (distribution !== null && distribution !== "classification") {
      throw new ApiError("invalid_request", 'distribution must be "classification".', 400);
    }
    return NextResponse.json(
      distribution === "classification"
        ? await classificationDistribution(scope, layer, field, request.signal)
        : await layerFieldStats(scope, layer, field, request.signal),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

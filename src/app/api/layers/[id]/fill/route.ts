import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireLayer, layerEffectiveSql } from "@/lib/layer-service";
import { classifyFill, type ClassifyMethod } from "@/lib/style/classify";

type Params = { params: Promise<{ id: string }> };

/**
 * Compute a data-driven paint for a layer's attribute (quantile,
 * equal-interval, natural-breaks, or categorical; optional palette, class
 * count, and reverse). Returns a paint the caller merges into the layer
 * style — the fill or, the data-driven outline — with the classification
 * (breaks, category colors) done server-side on DuckDB.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const layer = requireLayer(scope, id);
    let body: {
      attribute?: unknown;
      method?: unknown;
      palette?: unknown;
      classes?: unknown;
      reversed?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (typeof body.attribute !== "string" || !body.attribute) {
      throw new ApiError("invalid_request", "attribute is required.", 400);
    }
    if (
      body.method !== "quantile" &&
      body.method !== "equal" &&
      body.method !== "natural" &&
      body.method !== "categorical" &&
      body.method !== "continuous"
    ) {
      throw new ApiError(
        "invalid_request",
        'method must be "quantile", "equal", "natural", "categorical", or "continuous".',
        400,
      );
    }
    if (body.palette !== undefined && typeof body.palette !== "string") {
      throw new ApiError("invalid_request", "palette must be a string.", 400);
    }
    if (body.classes !== undefined && typeof body.classes !== "number") {
      throw new ApiError("invalid_request", "classes must be a number.", 400);
    }
    if (body.reversed !== undefined && typeof body.reversed !== "boolean") {
      throw new ApiError("invalid_request", "reversed must be a boolean.", 400);
    }
    // Classify what is actually drawn: the effective query, so filters are
    // respected and aggregated layers classify their aggregate value.
    const fill = await classifyFill(
      await layerEffectiveSql(layer, request.signal),
      body.attribute,
      body.method as ClassifyMethod,
      {
        palette: body.palette as string | undefined,
        classes: body.classes as number | undefined,
        reversed: body.reversed as boolean | undefined,
      },
      request.signal,
    );
    return NextResponse.json(fill);
  } catch (error) {
    return errorResponse(error);
  }
}

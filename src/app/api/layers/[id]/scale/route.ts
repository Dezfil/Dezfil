import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireLayer, layerEffectiveSql } from "@/lib/layer-service";
import { computeSizeScale } from "@/lib/style/classify";
import { SIZE_RANGE_MAX_PX, EXTRUSION_MAX_M } from "@/lib/style/style";

type Params = { params: Promise<{ id: string }> };

/**
 * Resolve a size scale (point radius or line width by attribute): the
 * attribute's value range over the layer's effective result, mapped onto the
 * requested pixel range. Returns a scale the caller merges into the style
 * (`pointRadiusBy` / `strokeWidthBy`) — the sibling of the paint operation,
 * for the size channels.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const layer = requireLayer(id);
    let body: { attribute?: unknown; range?: unknown; unit?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (typeof body.attribute !== "string" || !body.attribute) {
      throw new ApiError("invalid_request", "attribute is required.", 400);
    }
    if (body.unit !== undefined && body.unit !== "px" && body.unit !== "m") {
      throw new ApiError(
        "invalid_request",
        'unit must be "px" (sizes, default) or "m" (extrusion heights).',
        400,
      );
    }
    // Pixel scales cap at mark sizes; meter scales at extrusion heights
    // (the height channel resolves through the same operation).
    const cap = body.unit === "m" ? EXTRUSION_MAX_M : SIZE_RANGE_MAX_PX;
    const r = body.range;
    const isPair =
      Array.isArray(r) &&
      r.length === 2 &&
      r.every((n) => typeof n === "number" && Number.isFinite(n));
    if (
      !isPair ||
      (r as number[])[0] < 0 ||
      (r as number[])[0] > (r as number[])[1] ||
      (r as number[])[1] > cap
    ) {
      throw new ApiError(
        "invalid_request",
        `range must be two numbers, 0 to ${cap}, smallest first.`,
        400,
      );
    }
    const range = r as [number, number];
    const scale = await computeSizeScale(
      await layerEffectiveSql(layer, request.signal),
      body.attribute,
      range,
      request.signal,
    );
    return NextResponse.json(scale);
  } catch (error) {
    return errorResponse(error);
  }
}

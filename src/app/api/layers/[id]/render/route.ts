import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireLayer, renderLayer } from "@/lib/layer-service";
import { renderLayerWithSelections } from "@/lib/widget-service";
import { isValidFilters } from "@/lib/viz";

type Params = { params: Promise<{ id: string }> };

/**
 * Render data (GeoJSON) for one layer. A layer that cannot render — deleted
 * table, over the cap — returns ok:false with a reason, not an HTTP error,
 * so the rest of a map keeps working.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const layer = requireLayer(id);
    return NextResponse.json(await renderLayer(layer, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Render with an ephemeral selection set — the settle lane for computed
 * visualizations (hexbin, grid, cluster, heatmap): cells re-bin and clusters
 * recount under the selections, with zero writes. The body carries
 * pre-resolved filters; they pass the stored-filter validation and compile
 * through the same escaping.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const selections = body.selections ?? [];
    if (!isValidFilters(selections)) {
      throw new ApiError(
        "invalid_request",
        "selections must be a list of filters: { field, kind: range | " +
          "timerange | values, … }.",
        400,
      );
    }
    const layer = requireLayer(id);
    return NextResponse.json(
      await renderLayerWithSelections(layer, selections, request.signal),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

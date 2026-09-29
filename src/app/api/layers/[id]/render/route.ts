import { privateTileAccess } from "@/lib/tiles/access";
import { requireRequestScope } from "@/lib/auth/scope-http";
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
    const scope = requireRequestScope(request);
    const { id } = await params;
    const layer = requireLayer(scope, id);
    const render = await renderLayer(scope, layer, request.signal, { tileAccess: privateTileAccess(scope, id) });
    requireLayer(scope, id);
    return NextResponse.json(render);
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
    const scope = requireRequestScope(request);
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
    const layer = requireLayer(scope, id);
    const render = await renderLayerWithSelections(scope, layer, selections, request.signal, { tileAccess: privateTileAccess(scope, id) });
    requireLayer(scope, id);
    return NextResponse.json(render);
  } catch (error) {
    return errorResponse(error);
  }
}

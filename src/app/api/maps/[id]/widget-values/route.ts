import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { mapWithLayers } from "@/lib/map-service";
import { computeWidgetValues } from "@/lib/widget-service";
import {
  isValidSelections,
  isValidWidgets,
  type MapWidget,
} from "@/lib/widgets";

type Params = { params: Promise<{ id: string }> };

/**
 * Batched widget values for a map: every visible widget computed server-side
 * over its layer's effective query, under an optional ephemeral selection
 * set. A read — selections are request data, never persisted, and each
 * selection's field resolves from the stored widget, never the request. An
 * optional draft widget previews the builder's open editor: validated like a
 * stored widget, computed alongside them, never written.
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
    if (!isValidSelections(selections)) {
      throw new ApiError(
        "invalid_request",
        "selections must be a list of { widgetId, kind: values | range, … } " +
          "entries, at most one per widget.",
        400,
      );
    }
    const map = mapWithLayers(id);
    let draft: MapWidget | undefined;
    if (body.draft !== undefined && body.draft !== null) {
      if (!isValidWidgets([body.draft])) {
        throw new ApiError(
          "invalid_request",
          "draft must be a single well-formed widget (the same shape the " +
            "map's widgets list holds).",
          400,
        );
      }
      draft = body.draft as MapWidget;
      if (
        draft.layerId !== null &&
        !map.layers.some((l) => l.id === draft!.layerId)
      ) {
        throw new ApiError(
          "invalid_request",
          "draft.layerId must be one of the map's layers.",
          400,
        );
      }
    }
    return NextResponse.json(
      await computeWidgetValues(
        map,
        map.layers,
        selections,
        draft,
        request.signal,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

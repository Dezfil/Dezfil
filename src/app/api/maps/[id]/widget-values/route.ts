import { largeBodyText } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireMap } from "@/lib/map-service";
import { privateWidgetValues } from "@/lib/private-widget-service";
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
    const scope = requireRequestScope(request);
    const { id } = await params;
    let body: Record<string, unknown> = {};
    try {
      const text = await largeBodyText(request);
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
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
    requireMap(scope, id);
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

    }
    return NextResponse.json(
      await privateWidgetValues(
        scope,
        id,
        selections,
        draft,
        request.signal,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { resolvePublication, requirePublicationScope } from "@/lib/publish/publication-scope";
import { layerExtent } from "@/lib/extent-service";
import { rateLimit } from "@/lib/publish/rate-limit";
import { isValidSelections, selectionFilter } from "@/lib/widgets";
import { assertPublishedSelections } from "@/lib/widget-service";
import { timeToMs } from "@/lib/time";
import type { LayerFilter } from "@/lib/viz";

type Params = { params: Promise<{ token: string; layerId: string }> };

/**
 * A published layer's current extent — what the reader's own state leaves
 * drawn, for the case the browser cannot answer: a tiled layer, whose
 * features never reach it whole.
 *
 * The reader never names a field. Widget selections arrive keyed by widget
 * id and their field comes from the stored widget, exactly as the
 * widget-values lane does it; the timeline window's field comes from the
 * map's stored dock. That is what keeps this from becoming a way to query
 * a column the publication does not expose.
 *
 * Empty is a distinct outcome from a failure: filtering everything away is
 * a normal thing for a reader to do.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { token, layerId } = await params;

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "anonymous";
    if (!rateLimit(`pub:${ip}`, Date.now())) {
      throw new ApiError(
        "rate_limited",
        "Too many requests. Please slow down.",
        429,
      );
    }

    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }

    const snapshot = resolvePublication(token);
    if (!snapshot) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }
    // A hidden layer is absent from the published payload; asking for its
    // extent must read exactly like asking for a layer that is not there.
    const layer = snapshot.layers.find((l) => l.id === layerId && l.visible);
    if (!layer) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }

    const extra: LayerFilter[] = [];

    const selections = body.selections ?? [];
    if (!isValidSelections(selections)) {
      throw new ApiError(
        "invalid_request",
        "selections must be a list of { widgetId, kind: values | range, … } " +
          "entries, at most one per widget.",
        400,
      );
    }
    if (snapshot.map.widgetsPublished) {
      // A hidden widget's id behaves exactly like an unknown one.
      const visible = new Map(
        snapshot.map.widgets
          .filter((w) => w.visible && w.layerId === layerId)
          .map((w) => [w.id, w]),
      );
      const active = selections.filter((s) => visible.has(s.widgetId));
      // The same gate the widget-values lane applies: a selection must be
      // evaluable before anything evaluates it, so a drifted field or an
      // incompatible kind answers its documented code rather than
      // reaching the engine as a generic failure.
      await assertPublishedSelections(snapshot.scope,
        snapshot.map,
        snapshot.layers,
        active,
        request.signal,
      );
      for (const selection of active) {
        const filter = selectionFilter(selection, visible.get(selection.widgetId));
        if (filter) extra.push(filter);
      }
    }

    // The timeline's field is the map's, never the request's.
    const dock = snapshot.map.timeline;
    const window = body.timeline as { min?: unknown; max?: unknown } | undefined;
    if (dock && dock.layerId === layerId && window) {
      const bound = (value: unknown) =>
        typeof value === "string" && Number.isFinite(timeToMs(value))
          ? value
          : null;
      extra.push({
        field: dock.field,
        kind: "timerange",
        min: bound(window.min),
        max: bound(window.max),
      });
    }

    const extent = await layerExtent(snapshot.scope, layer, extra, request.signal);
    requirePublicationScope(snapshot.scope);
    return NextResponse.json(extent, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

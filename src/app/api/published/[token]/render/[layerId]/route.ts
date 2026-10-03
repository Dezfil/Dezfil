import { withRouteGate, gateOnly } from "@/lib/auth/route-gate";
import { publishedJsonBody } from "@/lib/publish/published-body";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { resolvePublication, requirePublicationScope } from "@/lib/publish/publication-scope";
import { sanitizePublishedRender } from "@/lib/publish/publish-service";
import { renderLayerWithSelections } from "@/lib/widget-service";
import { isValidFilters } from "@/lib/viz";
import { rateLimit } from "@/lib/publish/rate-limit";

type Params = { params: Promise<{ token: string; layerId: string }> };

/**
 * The published settle lane: re-render one computed layer — hexbin, grid,
 * cluster, heatmap — under a reader's ephemeral selections. Read-only under
 * the guarantees: the token must currently resolve, widgets must ship with
 * this map, selections pass stored-filter validation, and the shared viewer
 * rate limit applies.
 */
async function read(request: Request, { params }: Params) {
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

    const body = await publishedJsonBody(request);
    const selections = body.selections ?? [];
    if (!isValidFilters(selections)) {
      throw new ApiError(
        "invalid_request",
        "selections must be a list of filters: { field, kind: range | " +
          "timerange | values, … }.",
        400,
      );
    }

    const snapshot = resolvePublication(token);
    if (!snapshot || !snapshot.map.widgetsPublished) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }
    // A hidden layer is absent from the published surface: the settle
    // lane answers for it exactly as for a layer that does not exist —
    // the same calm 404, nothing to distinguish.
    const layer = snapshot.layers.find((l) => l.id === layerId);
    if (!layer || !layer.visible) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }
    const render = await renderLayerWithSelections(snapshot.scope,
      layer,
      selections,
      request.signal,
      {
        // The settle lane answers anonymous readers: properties carry the
        // effective published field set, exactly as the view payload
        // does.
        published: {
          timeline: snapshot.map.timeline,
          widgets: snapshot.map.widgets,
          widgetsPublished: snapshot.map.widgetsPublished,
        },
      },
    );
    // The settle lane's errored envelope carries the catalogue sentence,
    // never engine text.
    requirePublicationScope(snapshot.scope);
    return NextResponse.json(sanitizePublishedRender(render), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Params) { return withRouteGate(request, () => read(request, context)); }
export async function GET(request: Request) { return gateOnly(request); }
export async function HEAD(request: Request) { return gateOnly(request); }
export async function OPTIONS(request: Request) { return gateOnly(request); }
export async function PUT(request: Request) { return gateOnly(request); }
export async function DELETE(request: Request) { return gateOnly(request); }
export async function PATCH(request: Request) { return gateOnly(request); }

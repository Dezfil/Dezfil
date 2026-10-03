import { withRouteGate, gateOnly } from "@/lib/auth/route-gate";
import { publishedJsonBody } from "@/lib/publish/published-body";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { publishedMessage } from "@/lib/api/error-catalogue";
import { resolvePublication, requirePublicationScope } from "@/lib/publish/publication-scope";
import {
  assertPublishedSelections,
  computeWidgetValues,
} from "@/lib/widget-service";
import { isValidSelections } from "@/lib/widgets";
import { rateLimit } from "@/lib/publish/rate-limit";

type Params = { params: Promise<{ token: string }> };

/**
 * Widget values for a published view: the live half of the dashboard. Same
 * computation as the builder path, under the published-view guarantees: the
 * token must currently resolve, the map must ship widgets, reader-supplied
 * selections pass the same validation and escaping as stored filters, and
 * the shared viewer rate limit applies. Unpublish cuts this off by
 * construction — the snapshot read is the authorization.
 */
async function read(request: Request, { params }: Params) {
  try {
    const { token } = await params;

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
    if (!isValidSelections(selections)) {
      throw new ApiError(
        "invalid_request",
        "selections must be a list of { widgetId, kind: values | range, … } " +
          "entries, at most one per widget.",
        400,
      );
    }

    const snapshot = resolvePublication(token);
    if (!snapshot || !snapshot.map.widgetsPublished) {
      throw new ApiError("not_found", "This map is not available.", 404);
    }
    // A hidden widget is absent from the published payload, so a
    // retained id must behave exactly like an unknown one: its selection
    // resolves to nothing anywhere downstream —
    // never a filter through a card the surface no longer shows.
    const visible = new Set(
      snapshot.map.widgets.filter((w) => w.visible).map((w) => w.id),
    );
    const active = selections.filter((s) => visible.has(s.widgetId));
    // Reader selections must be evaluable before anything evaluates —
    // the induction half of the disclosure guard on this lane.
    await assertPublishedSelections(snapshot.scope,
      snapshot.map,
      snapshot.layers,
      active,
      request.signal,
    );
    const values = await computeWidgetValues(snapshot.scope,
      snapshot.map,
      snapshot.layers,
      active,
      undefined,
      request.signal,
    );
    // A failed widget's message on the anonymous wire is the catalogue
    // sentence for its code; the raw engine text stays on the builder's
    // authenticated-equivalent lane.
    const wire = {
      ...values,
      widgets: values.widgets.map((w) =>
        "error" in w ? { ...w, error: publishedMessage(w.errorCode) } : w,
      ),
    };
    requirePublicationScope(snapshot.scope);
    return NextResponse.json(wire, {
      // Values are live truth for the current token row; never store them.
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

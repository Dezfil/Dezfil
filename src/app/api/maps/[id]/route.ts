import { largeJsonValue } from "@/lib/api/json-body";
import { assertMapLayerRefs } from "@/lib/map-layer-refs";
import { listLayers } from "@/lib/metadata/maps";
import { requireDocumentRevision } from "@/lib/metadata/revisions";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { changeGroupOf } from "@/lib/api/change-group";
import {
  readMap,
  updateMap,
  removeMap,
  validateMapWriteRefs,
  requireMapFor,
} from "@/lib/map-service";
import { mapWriteChangesPublication } from "@/lib/publication-settings";
import { mapPresence } from "@/lib/reach-presence";
import type { BasemapKey } from "@/lib/basemap";
import { normalizeViewport, requireBasemapKey } from "@/lib/map-document-rules";
import { resolveCustomBasemapWrite } from "@/lib/basemap-custom";
import { requireAllowedStyleAddress } from "@/lib/basemap-rule";
import type { CustomBasemap, Viewport } from "@/lib/metadata/maps";

type Params = { params: Promise<{ id: string }> };

/** Read a map's full definition, including its layers, its owner and its
 * SQL home: the caller's own map, or one filed in a project they reach. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(readMap(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Update a map: name, viewport, basemap, basemap layers, note, legend corner, timeline, and/or layer order. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const current = requireMapFor(scope, id, "edit");
    let body: Record<string, unknown>;
    try {
      body = (await largeJsonValue(request)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    // A publication setting is refused before anything is inspected.
    if (mapWriteChangesPublication(current, body)) requireMapFor(scope, id, "publish");
    assertMapLayerRefs(current, listLayers(id), body);
    if (["name", "basemap", "customBasemap", "basemapLayers", "legendCorner", "legendOrder", "timeline", "widgets", "widgetsPublished", "layerOrder"].some(key => body[key] !== undefined)) {
      requireDocumentRevision(scope, { kind: "map", id, expectedRevision: request.headers.get("X-Edit-Revision") });
    }
    const fields: {
      name?: string;
      viewport?: Viewport;
      basemap?: BasemapKey | null;
      customBasemap?: CustomBasemap | null;
      libraryStyle?: string;
      basemapLayers?: unknown;
      legendCorner?: unknown;
      legendOrder?: unknown;
      timeline?: unknown;
      widgets?: unknown;
      widgetsPublished?: unknown;
      layerOrder?: string[];
    } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string")
        throw new ApiError("invalid_request", "name must be a string.", 400);
      fields.name = body.name;
    }
    if (body.viewport !== undefined) {
      fields.viewport = normalizeViewport(body.viewport);
    }
    if (body.basemap !== undefined) {
      fields.basemap = requireBasemapKey(body.basemap);
    }
    if (body.customBasemap !== undefined) {
      // Shape, inspection, and block-vs-force semantics live in the
      // module; the service stores what it returns. The inspection is
      // why this branch alone is asynchronous.
      // A pasted address this instance does not take now is refused before
      // the server reads it; the write checks again as it stores.
      const held = current.customBasemap?.url ?? null;
      fields.customBasemap = await resolveCustomBasemapWrite(
        body.customBasemap, undefined, undefined,
        (url) => requireAllowedStyleAddress(held, url),
      );
      // A style taken from the library by its id: the id travels with its
      // copy into the write, which asks the library again as it stores.
      const taken = (body.customBasemap as { libraryStyle?: unknown } | null)?.libraryStyle;
      if (typeof taken === "string") fields.libraryStyle = taken;
    }
    if (body.basemapLayers !== undefined) {
      // Group keys and values are validated in the service — the toggles
      // travel through every caller (UI, agents) with the same rules.
      fields.basemapLayers = body.basemapLayers;
    }
    if (body.note !== undefined) {
      // The note retired into a note widget.
      throw new ApiError(
        "invalid_request",
        "The map note is now a note widget. Send it in `widgets`.",
        400,
      );
    }
    if (body.legendCorner !== undefined) {
      // Validated in the service, same rules for every caller.
      fields.legendCorner = body.legendCorner;
    }
    if (body.legendOrder !== undefined) {
      // Exact-permutation-or-null validation lives in the service, same
      // rules for every caller.
      fields.legendOrder = body.legendOrder;
    }
    if (body.timeline !== undefined) {
      // Shape and dock target are validated in the service — the timeline
      // travels through every caller (UI, agents) with the same rules.
      fields.timeline = body.timeline;
    }
    if (body.widgets !== undefined) {
      // Shape and layer ownership are validated in the service — widgets
      // travel through every caller (UI, agents) with the same rules.
      fields.widgets = body.widgets;
    }
    if (body.widgetsPublished !== undefined) {
      fields.widgetsPublished = body.widgetsPublished;
    }
    if (body.layerOrder !== undefined) {
      if (
        !Array.isArray(body.layerOrder) ||
        !body.layerOrder.every((x) => typeof x === "string")
      ) {
        throw new ApiError(
          "invalid_request",
          "layerOrder must be an array of layer ids.",
          400,
        );
      }
      fields.layerOrder = body.layerOrder as string[];
    }
    // Semantic gate first: column references the request introduces or
    // changes resolve against their layer's result before the
    // synchronous write runs.
    await validateMapWriteRefs(scope, id, fields, request.signal);
    return NextResponse.json({
      ...(await updateMap(scope, id, fields, { groupId: changeGroupOf(request), expectedRevision: request.headers.get("X-Edit-Revision") })),
      ...mapPresence(scope, id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete a map and its layers. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    await removeMap(scope, id, { expectedRevision: _request.headers.get("X-Edit-Revision") });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

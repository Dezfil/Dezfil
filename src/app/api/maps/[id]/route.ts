import { requireRequestScope } from "@/lib/auth/scope-http";
import { cameraBoundsProblem } from "@/lib/camera-bounds";
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
import { isBasemapKey, type BasemapKey } from "@/lib/basemap";
import { resolveCustomBasemapWrite } from "@/lib/basemap-custom";
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
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    // A publication setting is refused before anything is inspected.
    if (mapWriteChangesPublication(current, body)) requireMapFor(scope, id, "publish");
    const fields: {
      name?: string;
      viewport?: Viewport;
      basemap?: BasemapKey | null;
      customBasemap?: CustomBasemap | null;
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
      const v = body.viewport as Record<string, unknown>;
      if (
        !v ||
        typeof v.lng !== "number" ||
        typeof v.lat !== "number" ||
        typeof v.zoom !== "number"
      ) {
        throw new ApiError(
          "invalid_request",
          "viewport must be { lng, lat, zoom } with optional pitch and bearing.",
          400,
        );
      }
      // Omitted pitch/bearing mean flat and north-up: one whole camera.
      const cameraProblem = cameraBoundsProblem(v);
      if (cameraProblem) throw new ApiError("invalid_request", cameraProblem, 400);
      if (
        v.bearing !== undefined &&
        (typeof v.bearing !== "number" || v.bearing < -360 || v.bearing > 360)
      ) {
        throw new ApiError(
          "invalid_request",
          "viewport.bearing must be a number of degrees, -360 to 360.",
          400,
        );
      }
      fields.viewport = {
        lng: v.lng,
        lat: v.lat,
        zoom: v.zoom,
        pitch: (v.pitch as number | undefined) ?? 0,
        bearing: (v.bearing as number | undefined) ?? 0,
      };
    }
    if (body.basemap !== undefined) {
      if (body.basemap !== null && !isBasemapKey(body.basemap)) {
        throw new ApiError(
          "invalid_request",
          "basemap must be one of dark, light, streets, satellite, or null for the deployment default.",
          400,
        );
      }
      fields.basemap = body.basemap as BasemapKey | null;
    }
    if (body.customBasemap !== undefined) {
      // Shape, inspection, and block-vs-force semantics live in the
      // module; the service stores what it returns. The inspection is
      // why this branch alone is asynchronous.
      fields.customBasemap = await resolveCustomBasemapWrite(
        body.customBasemap,
      );
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
      ...(await updateMap(scope, id, fields, { groupId: changeGroupOf(request) })),
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
    await removeMap(scope, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

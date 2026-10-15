import { largeJsonValue } from "@/lib/api/json-body";
import { requireDocumentRevision } from "@/lib/metadata/revisions";
import { readLayer } from "@/lib/layer-access";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { changeGroupOf } from "@/lib/api/change-group";
import {
  cascadeDeleteSketch,
  sketchOwnedByLayer,
} from "@/lib/sketch/store";
import { updateLayer } from "@/lib/layer-service";
import { requireLayerFor } from "@/lib/layer-access";
import { layerWriteChangesPublication } from "@/lib/publication-settings";
import { removeLayer } from "@/lib/layer-removal";
import { layerFieldsFromBody } from "@/lib/layer-document-rules";

type Params = { params: Promise<{ id: string }> };

/** Read a layer's full definition (SQL, name, style, visibility). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(readLayer(scope, id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Update a layer's SQL, name, style, visibility, tooltip, or legend flag. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const current = requireLayerFor(scope, id, "edit");
    let body: Record<string, unknown>;
    try {
      body = (await largeJsonValue(request)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const fields = layerFieldsFromBody(body);
    // A publication setting is refused before anything is inspected.
    if (layerWriteChangesPublication(current, fields)) requireLayerFor(scope, id, "publish");
    return NextResponse.json(
      await updateLayer(scope, id, fields, {
        expectedRevision: request.headers.get("X-Edit-Revision"), groupId: changeGroupOf(request),
        signal: request.signal,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete a layer from its map. A sketch's provenance-named owning
 * layer cascades to its dataset here too — the cascade is the layer's
 * deletion semantic, enforced at the API so a non-browser caller and a
 * builder whose summaries have not loaded get the same outcome, never
 * an orphaned dataset plus an undoable step. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const layer = requireLayerFor(scope, id, "edit");
    requireDocumentRevision(scope, { kind: "map", id: layer.mapId, expectedRevision: request.headers.get("X-Edit-Revision") });
    const owned = sketchOwnedByLayer(scope, id);
    if (owned) {
      return NextResponse.json(await cascadeDeleteSketch(scope, owned.name, "layer", { expectedRevision: request.headers.get("X-Edit-Revision"), signal: request.signal }));
    }
    return NextResponse.json(await removeLayer(scope, id, { expectedRevision: request.headers.get("X-Edit-Revision"), groupId: changeGroupOf(request) }));
  } catch (error) {
    return errorResponse(error);
  }
}

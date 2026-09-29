import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { createSketch, mapSketches } from "@/lib/sketch/store";
import { requireMap } from "@/lib/map-service";

type Params = { params: Promise<{ id: string }> };

/** The map's sketch datasets — provenance and per-kind counts. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    requireMap(scope, id);
    return NextResponse.json(await mapSketches(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * First commit of a draw session: one failure-safe outcome minting the
 * sketch dataset and its owning layer together. Nothing enters map
 * history.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    let body: { feature?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const created = await createSketch(scope, id, body.feature);
    return NextResponse.json(
      {
        table: created.table.name,
        tableId: created.table.id,
        layerId: created.layerId,
        layerName: created.layerName,
        featureId: created.featureId,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

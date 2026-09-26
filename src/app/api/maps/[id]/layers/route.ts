import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { changeGroupOf } from "@/lib/api/change-group";
import { listLayers } from "@/lib/metadata/maps";
import { requireMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import type { LayerStyle } from "@/lib/style/style";

type Params = { params: Promise<{ id: string }> };

/** List a map's layers. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    requireMap(id);
    return NextResponse.json(listLayers(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create a layer on a map from a SQL result. */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    let body: { name?: unknown; sql?: unknown; style?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (typeof body.sql !== "string" || body.sql.trim() === "") {
      throw new ApiError(
        "invalid_request",
        "sql must be a non-empty string.",
        400,
      );
    }
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name
        : "Untitled layer";
    const layer = await createLayer(
      id,
      {
        name,
        sql: body.sql,
        style: body.style as LayerStyle | undefined,
      },
      { groupId: changeGroupOf(request), signal: request.signal },
    );
    return NextResponse.json(layer, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

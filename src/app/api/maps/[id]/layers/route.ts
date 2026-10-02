import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { changeGroupOf } from "@/lib/api/change-group";
import { mapWithLayers, requireMapFor } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import type { LayerStyle } from "@/lib/style/style";
import { isEvaluationContext, mapEvaluation } from "@/lib/query/context";
import { carriedSql, parseWrittenIn, writtenInContext } from "@/lib/query/written-in";

type Params = { params: Promise<{ id: string }> };

/** List a map's layers. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { id } = await params;
    return NextResponse.json(mapWithLayers(scope, id).layers);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create a layer on a map from a SQL result. */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    requireMapFor(scope, id, "edit");
    let body: { name?: unknown; sql?: unknown; style?: unknown; writtenIn?: unknown };
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
    // SQL written elsewhere (the caller's console, another map, a workflow)
    // is carried into this map's home before it is admitted and stored.
    const written = parseWrittenIn(body.writtenIn, ["console", "map", "workflow"]);
    const here = mapEvaluation(scope, id);
    const sql = written && isEvaluationContext(here)
      ? await carriedSql(body.sql, writtenInContext(scope, written), here, { signal: request.signal })
      : body.sql;
    const layer = await createLayer(scope,
      id,
      {
        name,
        sql,
        style: body.style as LayerStyle | undefined,
      },
      { groupId: changeGroupOf(request), signal: request.signal },
    );
    return NextResponse.json(layer, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { deleteFeature, moveVertex } from "@/lib/sketch/store";

type Params = { params: Promise<{ name: string; featureId: string }> };

/**
 * The one permitted edit: move exactly one vertex of a
 * polygon-kind feature. Kind and vertex count are preserved; anything
 * broader is refused.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { name, featureId } = await params;
    let body: { vertexIndex?: unknown; position?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (typeof body.vertexIndex !== "number")
      throw new ApiError(
        "invalid_request",
        "vertexIndex must be a number.",
        400,
      );
    const result = await moveVertex(
      scope,
      name,
      featureId,
      body.vertexIndex,
      body.position,
    );
    return NextResponse.json({ rowCount: result.rowCount });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete exactly one drawn feature — its row leaves the dataset. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { name, featureId } = await params;
    const result = await deleteFeature(scope, name, featureId);
    return NextResponse.json({ rowCount: result.rowCount });
  } catch (error) {
    return errorResponse(error);
  }
}

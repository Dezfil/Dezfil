import { largeJsonValue } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { appendFeature, listFeatures } from "@/lib/sketch/store";

type Params = { params: Promise<{ name: string }> };

/** The sketch's drawn features with their stable ids and kinds. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(_request);
    const { name } = await params;
    return NextResponse.json({ features: await listFeatures(scope, name) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Append one drawn feature — the same structural gate as the UI. */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { name } = await params;
    let body: { feature?: unknown };
    try {
      body = (await largeJsonValue(request)) as typeof body;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const result = await appendFeature(scope, name, body.feature);
    return NextResponse.json(
      { featureId: result.featureId, rowCount: result.rowCount },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

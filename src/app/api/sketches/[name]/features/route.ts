import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { appendFeature, listFeatures } from "@/lib/sketch/store";

type Params = { params: Promise<{ name: string }> };

/** The sketch's drawn features with their stable ids and kinds. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { name } = await params;
    return NextResponse.json({ features: await listFeatures(name) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Append one drawn feature — the same structural gate as the UI. */
export async function POST(request: Request, { params }: Params) {
  try {
    const { name } = await params;
    let body: { feature?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const result = await appendFeature(name, body.feature);
    return NextResponse.json(
      { featureId: result.featureId, rowCount: result.rowCount },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

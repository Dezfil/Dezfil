import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { transferWorkflow } from "@/lib/metadata/transfers";

type Params = { params: Promise<{ id: string }> };

/** Make someone who already reaches the workflow its owner: the owner's act. */
export async function POST(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const to = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).to : undefined;
    return NextResponse.json(transferWorkflow(scope, id, to));
  } catch (error) {
    return errorResponse(error);
  }
}

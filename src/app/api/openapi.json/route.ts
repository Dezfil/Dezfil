import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

/** The machine-readable API description (spec: ships alongside the human docs
 * and never diverges). wraps this as MCP tools. */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    return privateResponse(NextResponse.json(buildOpenApiDocument()));
  } catch (error) { return authFailure(error); }
}

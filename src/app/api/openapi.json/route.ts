import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api/openapi";

/** The machine-readable API description (spec: ships alongside the human docs
 * and never diverges). wraps this as MCP tools. */
export async function GET() {
  return NextResponse.json(buildOpenApiDocument());
}

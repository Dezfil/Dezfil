import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { sanitizeSvgIcon } from "@/lib/icon-sanitize";

/**
 * Advisory sanitization of custom icon SVG: the same boundary the layer
 * write applies, exposed so the picker can preview the accepted markup
 * and report what would be dropped before the author commits. The
 * authoritative decision remains the layer write's, which re-sanitizes.
 * Rejections (not SVG, oversize, nothing drawable) are the documented
 * invalid_request wordings.
 */
export async function POST(request: Request) {
  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ApiError(
        "invalid_request",
        "The request body must be a JSON object.",
        400,
      );
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body.svg !== "string") {
      throw new ApiError(
        "invalid_request",
        "svg must be a string of SVG text.",
        400,
      );
    }
    return NextResponse.json(sanitizeSvgIcon(body.svg));
  } catch (error) {
    return errorResponse(error);
  }
}

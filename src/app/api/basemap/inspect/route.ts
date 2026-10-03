import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { inspectStyle } from "@/lib/net/inspect-style";
import { CUSTOM_URL_MAX } from "@/lib/basemap-custom";

/**
 * Advisory inspection of a custom basemap style URL: one bounded fetch
 * through the egress policy, answering one of four verdicts with a
 * summary and attribution preview. The panel checks here before
 * offering the save; the authoritative decision is the map write's,
 * which re-inspects. Verdicts are 200s — a dead URL is a normal thing
 * to ask about.
 */
export async function POST(request: Request) {
  try {
    let parsed: unknown;
    try {
      parsed = await largeJsonValue(request);
    } catch (error) {
      if (error instanceof ApiError) throw error;
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
    if (typeof body.url !== "string" || !body.url.trim()) {
      throw new ApiError(
        "invalid_request",
        "url must be a non-empty string.",
        400,
      );
    }
    const url = body.url.trim();
    if (url.length > CUSTOM_URL_MAX) {
      throw new ApiError(
        "invalid_request",
        `url must be at most ${CUSTOM_URL_MAX} characters.`,
        400,
      );
    }
    return NextResponse.json(await inspectStyle(url));
  } catch (error) {
    return errorResponse(error);
  }
}

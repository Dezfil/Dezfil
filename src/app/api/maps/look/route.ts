import { accountScope } from "@/lib/auth/scope";
import { delegateCredential } from "@/lib/auth/delegation";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { lookRetention } from "@/lib/export/look-retention";
import { isAppearance, lookAtMap, lookFacts } from "@/lib/export/map-look";
import { selfBaseUrl } from "@/lib/self-url";

/**
 * Look at a map: the model-facing check, a documented read-only
 * operation over the export render road with its own bounds. The map is
 * named in the body so a call naming none is the documented validation
 * outcome rather than a missing path; the assistant, as a client,
 * supplies its contextual map when the model names none. The answer is
 * the image, base64 in a JSON body, beside the render's facts, which
 * carry no bytes.
 */

interface RequestBody { mapId?: unknown; appearance?: unknown }

export async function POST(request: Request) {
  try {
    const actor = requireRequestAuth(request);
    const scope = accountScope(actor);
    let body: RequestBody = {};
    const text = await request.text();
    if (text.trim()) {
      try { body = JSON.parse(text) as RequestBody; } catch { throw new ApiError("invalid_request", "Expected a JSON object body.", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("invalid_request", "Expected a JSON object body.", 400);
    }
    if (body.mapId === undefined || body.mapId === null) throw new ApiError("look_target_missing", ERROR_CATALOGUE.look_target_missing, 400);
    if (typeof body.mapId !== "string" || body.mapId.trim() === "") throw new ApiError("invalid_request", "mapId must be a non-empty string.", 400);
    if (body.appearance !== undefined && !isAppearance(body.appearance)) throw new ApiError("invalid_request", 'appearance must be "light" or "dark".', 400);
    const result = await lookAtMap(scope, {
      mapId: body.mapId,
      appearance: body.appearance,
      baseUrl: selfBaseUrl(request),
      credential: delegateCredential(actor),
      signal: request.signal,
    });
    // The retained working state: the image the model was given and its
    // thumbnail, for the pane's note and for a later read, under the
    // documented bounds.
    lookRetention.retain(scope, result);
    return privateResponse(NextResponse.json({
      render: lookFacts(result),
      image: { content_type: "image/png", width: result.image.width, height: result.image.height, bytes: result.image.bytes, content_base64: Buffer.from(result.image.png).toString("base64") },
    }));
  } catch (error) {
    return authFailure(error);
  }
}

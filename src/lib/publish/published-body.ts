import { ApiError } from "@/lib/api/errors";
import { boundedBodyText } from "@/lib/api/bounded-body";
import { SMALL_JSON_BODY_MAX_BYTES } from "@/lib/api/request-bounds";

/** Keep the published readers' absent-body and malformed-JSON behavior. */
export async function publishedJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await boundedBodyText(request, SMALL_JSON_BODY_MAX_BYTES);
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("invalid_request", "Expected a JSON body.", 400);
  }
}

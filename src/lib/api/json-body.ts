import { boundedBodyText } from "./bounded-body";
import { SMALL_JSON_BODY_MAX_BYTES } from "./request-bounds";

/** Admission is outside the parse fallback: malformed JSON may select an old
 * default, but an oversized body can never do so. */
async function jsonValue(request: Request, limit: number, invalid?: () => unknown): Promise<unknown> {
  const text = await boundedBodyText(request, limit);
  try { return JSON.parse(text); }
  catch (error) { if (invalid) return invalid(); throw error; }
}
export function smallJsonValue(request: Request, invalid?: () => unknown): Promise<unknown> {
  return jsonValue(request, SMALL_JSON_BODY_MAX_BYTES, invalid);
}

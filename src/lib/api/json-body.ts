import { boundedBodyText } from "./bounded-body";
import { SMALL_JSON_BODY_MAX_BYTES, LARGE_JSON_BODY_MAX_BYTES } from "./request-bounds";

/** Admission is outside the parse fallback: malformed JSON may select an old
 * default, but an oversized body can never do so. Replacement decoding keeps
 * the platform Request.json/text behavior for admitted bytes. */
async function jsonValue(request: Request, limit: number, invalid?: () => unknown): Promise<unknown> {
  const text = await boundedBodyText(request, limit, { fatal: false });
  try { return JSON.parse(text); }
  catch (error) { if (invalid) return invalid(); throw error; }
}
export function smallJsonValue(request: Request, invalid?: () => unknown): Promise<unknown> {
  return jsonValue(request, SMALL_JSON_BODY_MAX_BYTES, invalid);
}

export function largeJsonValue(request: Request, invalid?: () => unknown): Promise<unknown> {
  return jsonValue(request, LARGE_JSON_BODY_MAX_BYTES, invalid);
}
export function largeBodyText(request: Request): Promise<string> {
  return boundedBodyText(request, LARGE_JSON_BODY_MAX_BYTES, { fatal: false });
}

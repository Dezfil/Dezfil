import { ApiError } from "./errors";

/** Admission counts wire bytes, independent of Content-Type or a low declared
 * length. A fixed owned buffer never retains the producer's backing storage. */
export async function boundedBodyText(request: Request, limit: number): Promise<string> {
  const tooLarge = () => new ApiError("request_body_too_large", `The request body exceeds the ${limit}-byte limit.`, 413);
  const declared = request.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && (!Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const buffer = new Uint8Array(limit);
  let bytes = 0;
  try {
    while (true) {
      let chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - bytes) {
        // Drop the crossing chunk before awaiting cancellation; never copy it
        // into retained payload storage or ask the producer for another chunk.
        chunk = { done: true, value: undefined };
        try { await reader.cancel(); } catch { /* The byte refusal wins. */ }
        throw tooLarge();
      }
      buffer.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally { reader.releaseLock(); }
}

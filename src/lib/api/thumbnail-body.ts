import { ApiError } from "./errors";

/** Far above any honest capture; a backstop, not a budget. */
export const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;

const SNAPSHOT_SENTENCE = `The snapshot must be a PNG of at most ${THUMBNAIL_MAX_BYTES / (1024 * 1024)} MB.`;

/** An empty body is a malformed snapshot, not an oversized one. */
export const emptySnapshot = () => new ApiError("invalid_request", SNAPSHOT_SENTENCE, 400);
const oversizedSnapshot = () => new ApiError("request_body_too_large", SNAPSHOT_SENTENCE, 413);

/** Binary snapshot admission counts wire bytes as they arrive. A declared
 * length past the bound refuses before any read; a body that crosses it is
 * refused on the crossing chunk, which is dropped, and the stream is cancelled
 * without asking the sender for another byte. */
export async function thumbnailBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > THUMBNAIL_MAX_BYTES) throw oversizedSnapshot();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  let buffer = new Uint8Array(0);
  let bytes = 0;
  try {
    while (true) {
      let chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > THUMBNAIL_MAX_BYTES - bytes) {
        chunk = { done: true, value: undefined };
        try { await reader.cancel(); } catch { /* The size refusal wins. */ }
        throw oversizedSnapshot();
      }
      const needed = bytes + chunk.value.byteLength;
      if (needed > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(THUMBNAIL_MAX_BYTES, Math.max(needed, buffer.byteLength * 2)));
        if (bytes) grown.set(buffer.subarray(0, bytes));
        buffer = grown;
      }
      buffer.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    return buffer.subarray(0, bytes);
  } finally { reader.releaseLock(); }
}

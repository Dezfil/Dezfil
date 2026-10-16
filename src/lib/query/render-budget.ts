import { ApiError } from "@/lib/api/errors";
import type { ByteBudget } from "./result-budget";

/** The refusal of a layer answer over Bytes drawn per layer. The value is
 * deployment-controlled, so the remedy names its variable. */
export function renderBytesExceeded(limit: number): ApiError {
  return new ApiError(
    "render_bytes_exceeded",
    `This layer's answer is larger than ${limit.toLocaleString("en-US")} bytes, the limit for one layer drawn in the map. ` +
      "Filter or aggregate it, or raise DEZFIL_RENDER_CAP_BYTES and restart.",
    422,
  );
}

/**
 * Bytes drawn per layer, charged while a layer answer is read and built:
 * every byte of the complete uncompressed UTF-8 JSON the answer serializes
 * to, its envelope included, counts exactly once. Equality is admitted. A
 * charge over the limit refuses before the value it measures is converted,
 * so a refusal never follows a complete construction. There is no separate
 * per-value ceiling.
 */
export class RenderBudget implements ByteBudget {
  private used = 0;
  constructor(readonly limit: number) {}

  take(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.used) {
      throw renderBytesExceeded(this.limit);
    }
    this.used += bytes;
  }

  /** Refuses, as `take` would, when `bytes` more would pass the limit, and
   * charges nothing: for a text converted before the length it serializes
   * to is known, which must fit what is left before it is converted. */
  admit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.used) {
      throw renderBytesExceeded(this.limit);
    }
  }

  /** The bytes admitted so far. */
  get spent(): number {
    return this.used;
  }
}

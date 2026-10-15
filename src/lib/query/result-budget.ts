import { QueryResultTooLarge } from "@/lib/api/errors";

export const RESULT_BYTES = 33_554_432;
export const CELL_BYTES = 2_097_152;

/** Count JSON without allocating its escaped representation. */
export function jsonBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") {
    let bytes = 2;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
      else if (c < 32) bytes += 6;
      else if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
      else bytes += 3;
    }
    return bytes;
  }
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce<number>((n, v) => n + jsonBytes(v), 0);
  if (typeof value === "object") {
    const entries = Object.entries(value as object).filter(([, v]) => v !== undefined);
    return 2 + Math.max(0, entries.length - 1) + entries.reduce((n, [k, v]) => n + jsonBytes(k) + 1 + jsonBytes(v), 0);
  }
  return JSON.stringify(value).length;
}

/** What the native decoders charge as they admit each serialized byte. */
export interface ByteBudget {
  take(bytes: number): void;
}

/** One complete REST answer, including its envelope. Readers opt in explicitly. */
export class ResultBudget {
  private used = 0;
  take(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RESULT_BYTES - this.used) throw new QueryResultTooLarge();
    this.used += bytes;
  }
}

export class CellBudget {
  private used = 0;
  constructor(private readonly result: ResultBudget, private readonly geometry = false) {}
  take(bytes: number): void {
    if (!this.geometry && bytes > CELL_BYTES - this.used) throw new QueryResultTooLarge();
    this.result.take(bytes);
    this.used += bytes;
  }
}

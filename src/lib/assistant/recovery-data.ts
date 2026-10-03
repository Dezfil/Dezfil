import { boundedBodyText } from "@/lib/api/bounded-body";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { RunReceipt } from "./runs";

export const RECOVERY_LIMITS = { slots: 8, reservationMs: 5 * 60_000, receipts: 256, receiptBytes: 64 * 1024, submissionBytes: 128 * 1024, liveBytes: 1024 * 1024 } as const;
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** The bytes of parked state, a binary counted by its own size rather than
 * as indexed JSON (a check's image in a batch's outcomes). */
export function parkedBytes(value: unknown): number {
  let binary = 0;
  const text = JSON.stringify(value, (_key, v) => { if (v instanceof Uint8Array) { binary += v.byteLength; return null; } return v; });
  return Buffer.byteLength(text, "utf8") + binary;
}
export function recoveryLimit(): never { throw new ApiError("assistant_recovery_limit", ERROR_CATALOGUE.assistant_recovery_limit, 413); }

/** Trim only display detail. Identities, outcomes and exact open arguments survive. */
export function compactReceipt(input: RunReceipt, maximum: number, terminal: boolean): RunReceipt {
  const receipt = structuredClone(input);
  if (jsonBytes(receipt) <= maximum) return receipt;
  receipt.incomplete = true;
  receipt.text = "";
  if (terminal) {
    // The mark is the fact that detail was dropped, so a call that carried
    // no arguments at all is never confused with one whose arguments went.
    for (const action of receipt.actions) { if (action.args !== undefined) { delete action.args; action.omitted = true; } }
    // A settled gate's arguments are display detail too: what was decided
    // and about which target survives, the exact call does not.
    for (const settled of receipt.confirmations ?? []) { if (settled.args !== undefined) { delete settled.args; settled.omitted = true; } }
    // A check's observation text and its state identity's detail are
    // display detail too: dropped only when the bound still presses,
    // marked unavailable, never read as silence.
    if (jsonBytes(receipt) > maximum) for (const action of receipt.actions) {
      if (action.observation?.text !== undefined || action.observation?.state === "captured") { action.observation = { state: "unavailable" }; action.omitted = true; }
    }
    // The detail lists go by absence, never emptied: an empty list is a
    // map with nothing visible, a missing one is detail not kept.
    if (jsonBytes(receipt) > maximum) for (const action of receipt.actions) {
      if (action.render && (action.render.state.layers || action.render.state.legend.order || action.render.state.widgets)) {
        const state = { ...action.render.state, legend: { ...action.render.state.legend } };
        delete state.layers; delete state.widgets; delete state.legend.order;
        action.render = { ...action.render, state };
        action.omitted = true;
      }
    }
  }
  if (jsonBytes(receipt) > maximum) recoveryLimit();
  // Keep the largest UTF-8 prefix that fits; surrogate pairs are never split.
  const points = Array.from(input.text);
  let lo = 0; let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    receipt.text = points.slice(0, mid).join("");
    if (jsonBytes(receipt) <= maximum) lo = mid; else hi = mid - 1;
  }
  receipt.text = points.slice(0, lo).join("");
  return receipt;
}

/** Count bytes while reading, before materializing an oversized submission. */
export async function readSubmission(request: Request): Promise<Record<string, unknown>> {
  const tooLarge = () => new ApiError("assistant_submission_too_large", ERROR_CATALOGUE.assistant_submission_too_large, 413);
  const text = await boundedBodyText(request, RECOVERY_LIMITS.submissionBytes, { tooLarge, fatal: false });
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch { throw new ApiError("invalid_request", "Expected a JSON object body.", 400); }
}

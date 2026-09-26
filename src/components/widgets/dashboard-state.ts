import type { LayerRenderData } from "@/lib/layer-service";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";

/**
 * The dashboard truth states: every answer surface — widget cards, the
 * records readout, a settled layer — is in exactly one state, and
 * nothing computed under other conditions is ever presented as current.
 * This module is the pure half; the dashboard hook binds it to fetch
 * lifecycles and the hosts render it.
 */

export type AnswerStatus = "loading" | "updating" | "current" | "failed";

export interface AnswerFailure {
  code: string;
  message: string;
}

export interface AnswerState {
  status: AnswerStatus;
  error: AnswerFailure | null;
}

export type EndpointResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AnswerFailure };

export const ANSWER_CURRENT: AnswerState = { status: "current", error: null };

/** Transport failure is client-local — it never appears on the wire, so
 * its prose ships here rather than in the API error catalogue. */
export const NETWORK_FAILURE: AnswerFailure = {
  code: "network",
  message: "Could not reach the server.",
};

/** Entering a recomputation: loading with no prior answer, updating over
 * one — the prior answer may stay visible only marked as being replaced. */
export function beginAnswer(hasPrior: boolean): AnswerState {
  return { status: hasPrior ? "updating" : "loading", error: null };
}

/**
 * Resolve a fetch outcome into the next state. A superseded outcome —
 * newer conditions took over before this answer arrived — is not a
 * failure and never regresses the state the newer fetch owns.
 */
export function resolveAnswer(
  prev: AnswerState,
  superseded: boolean,
  outcome: EndpointResult<unknown>,
): AnswerState {
  if (superseded) return prev;
  return outcome.ok
    ? ANSWER_CURRENT
    : { status: "failed", error: outcome.error };
}

/**
 * The text a failed surface shows. Authors (the builder) keep the raw
 * detail — an authenticated surface. Readers (the published viewer) get
 * the documented catalogue prose keyed on the code and never the raw
 * message, which can carry engine text that must not widen.
 */
export function failureProse(
  failure: AnswerFailure | null,
  audience: "author" | "reader",
): string {
  const fallback = "This couldn't be computed right now.";
  if (!failure) return fallback;
  if (audience === "author") return failure.message || fallback;
  if (failure.code === NETWORK_FAILURE.code) return NETWORK_FAILURE.message;
  return (
    (ERROR_CATALOGUE as Record<string, string>)[failure.code] ?? fallback
  );
}

/**
 * Fold a settle fetch into one verdict: the transport/HTTP layer and the
 * render envelope can each fail, and both mean the selection is not
 * applied. A usable render carries features; an errored envelope carries
 * the coded reason the server minted.
 */
export function settleVerdict(result: EndpointResult<LayerRenderData>): {
  render: LayerRenderData | null;
  failure: AnswerFailure | null;
} {
  if (!result.ok) return { render: null, failure: result.error };
  if (!result.data.ok) {
    return {
      render: null,
      failure: result.data.error ?? {
        code: "internal",
        message: "The layer could not render.",
      },
    };
  }
  return { render: result.data, failure: null };
}

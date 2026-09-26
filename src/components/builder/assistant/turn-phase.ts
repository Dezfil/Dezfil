import type { PendingReceipt } from "@/lib/assistant/runs";
import type { RecordEntry } from "./record-projection";

/**
 * The pane's phase: what the composer and the slot control show, and
 * what the live turn's indicators mean, decided from the conversation's
 * state and nothing else. Execution and a parked confirmation wear the
 * running controls; an observational
 * recovery read wears the ordinary ones; the idle pane offers Send.
 * Pure; the pane reads it.
 */
export type TurnPhase = "idle" | "executing" | "parked" | "reading";

export interface PhaseInput {
  /** A submission, a resolution, a stop or a recovery read is in flight. */
  busy: boolean;
  /** The flight is a recovery read, not execution. */
  reading: boolean;
  pending: PendingReceipt | null;
}

export function turnPhase({ busy, reading, pending }: PhaseInput): TurnPhase {
  if (busy) return reading ? "reading" : "executing";
  if (pending) return "parked";
  return "idle";
}

/** The control in Send's slot reads Stop while the turn executes or waits at a card. */
export const showsStop = (phase: TurnPhase) => phase === "executing" || phase === "parked";

/** The composer is disabled with "Working…" in the same two phases. */
export const composerWorking = (phase: TurnPhase) => showsStop(phase);

export interface IndicatorInput {
  phase: TurnPhase;
  text: string;
  entries: RecordEntry[];
  pending: PendingReceipt | null;
  /** A text delta stream is open on the turn. */
  streaming: boolean;
}

/** The thinking indicator: present before the first action or word and
 * while the first text is awaited after actions settle; absent during a
 * running action, a parked confirmation and any shown text. */
export function showsIndicator({ phase, text, entries, pending }: IndicatorInput): boolean {
  if (phase !== "executing") return false;
  if (text !== "" || pending) return false;
  return !entries.some((entry) => entry.status === "running");
}

/** The caret: on the active text segment only, while the turn executes. */
export function showsCaret({ phase, text, streaming }: IndicatorInput): boolean {
  return phase === "executing" && text !== "" && streaming;
}

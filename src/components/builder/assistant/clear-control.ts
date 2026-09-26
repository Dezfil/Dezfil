import type { LiveTurn } from "./assistant-turn-state";

/**
 * Whether the pane offers to end the conversation, and whether the offer
 * can be taken.
 *
 * Absent rather than disabled when there is nothing to clear: a control
 * that can never do anything is furniture, and page 05 draws none. Present
 * but disabled wherever a run is still the server's: a turn in flight, a
 * confirmation card waiting (Stop first), a departed run's recovery
 * door, and the settlement read that door starts. The rule reads the same
 * conversation state the door itself reads, so the two cannot disagree
 * about whether a run is outstanding.
 */
export interface ClearState {
  /** Settled turns in the transcript. */
  turns: number;
  live: LiveTurn;
  /** A submission, a resolution, a stop or a recovery read is in flight. */
  busy: boolean;
  recoveryId: string | null;
}

export function clearControl({ turns, live, busy, recoveryId }: ClearState): "absent" | "ready" | "disabled" {
  const said = turns > 0 || live.message !== undefined || live.text !== "" || live.actions.length > 0 || live.pending !== null;
  if (!said) return "absent";
  return busy || live.pending !== null || recoveryId !== null ? "disabled" : "ready";
}

/** The hint the disabled control carries, and nothing the enabled one
 * does: a hint names a surprise (` `), and an inert control is one. */
export const CLEAR_LABEL = "Clear conversation";
export const CLEAR_WAIT_HINT = "Clear conversation. Press Stop first.";

/** The composer input's own hook. Focus lands there after a clear (spec
 * item 6), and naming the selector in one place is what keeps the move
 * from quietly resolving to nothing when the markup changes. */
export const ASSISTANT_INPUT = "data-assistant-input";

/** Move focus to the composer input inside this pane, if it is there. */
export function focusComposer(pane: HTMLElement | null) {
  pane?.querySelector<HTMLTextAreaElement>(`textarea[${ASSISTANT_INPUT}]`)?.focus();
}

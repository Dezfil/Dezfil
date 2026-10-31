import { ASSISTANT_ACCOUNT_CAPACITY } from "@/lib/api/error-catalogue";

/**
 * The pane's words for a failure. Every assistant failure path carries
 * a structured code with its text to the pane; the boundary words it
 * for a person here. Only the assistant's own lifecycle codes are
 * reworded, since their catalogue texts address a client (a method, a
 * path, a status); a product error, a SQL error and a provider's own
 * text pass through with their numbers and identifiers intact, and the
 * API's texts are never changed. The pane's own notes carry the code
 * `pane` and pass through.
 */
export interface PaneFailure { code: string; message: string; detail?: string }
export interface PaneSituation {
  /** How many pending actions the pane can offer to recover right now. */
  pendingActions: number;
}

const CAPACITY = "The assistant is at capacity: eight requests are open on this instance.";
const ACCOUNT_CAPACITY = "You have four requests open, the most one person may.";

const WORDS: Record<string, string> = {
  assistant_reservation_required: "The message could not be started. Send it again.",
  assistant_run_unavailable: "This request is no longer available. It will not be repeated.",
  assistant_run_conflict: "This request was already sent with different content. Send a new message.",
  assistant_run_state: "This request is not in a state that allows that. Check its outcome first.",
  assistant_submission_too_large: "The message and its context are too large to send. Shorten the message.",
  assistant_recovery_limit: "The request stopped before its record could outgrow what can be recovered. Send a shorter request.",
  pending_unknown: "This confirmation is no longer available and nothing ran. Send a new message.",
  pending_resolved: "This action was already answered. It will not run again.",
  pending_superseded: "A newer message declined this action.",
  assistant_reservation_limit: "Two of your messages have not started yet. Wait a few minutes, then send again.",
};

/** Which key pays, where there are two it could be. An instance with none says
 * nothing: the person's own key is the only one there is. */
export function payerWords(status: { instanceKey?: boolean; payer?: { kind: "own" | "instance" } }): string | null {
  if (!status.instanceKey || !status.payer) return null;
  return status.payer.kind === "own" ? "your key" : "instance key";
}

export function failureWords(failure: PaneFailure, situation: PaneSituation): string {
  if (failure.code === "assistant_capacity") {
    const full = failure.message === ASSISTANT_ACCOUNT_CAPACITY ? ACCOUNT_CAPACITY : CAPACITY;
    return situation.pendingActions > 0
      ? `${full} Recover a pending action below, or abandon it, to free one.`
      : `${full} Wait for one to finish, then send again.`;
  }
  if (failure.code === "internal" && /^Request failed \(\d{3}\)$/.test(failure.message)) return "Something went wrong on the instance. Try again.";
  return WORDS[failure.code] ?? failure.message;
}

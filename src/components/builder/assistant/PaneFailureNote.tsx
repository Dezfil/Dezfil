"use client";
import { ErrorNote } from "../../ui/ErrorNote";
import { failureWords, type PaneFailure } from "./assistant-words";

/**
 * The pane's rendering boundary for a failure: every assistant failure
 * path (the HTTP response, the stream's error event, an action result,
 * a recovery read) reaches the pane as a structured code with its text,
 * and is worded here for a person. The API's own texts are unchanged;
 * what a person reads is the boundary's.
 */
export function PaneFailureNote({ failure, pendingActions, onDismiss }: {
  failure: PaneFailure;
  /** How many pending actions the pane can offer to recover right now. */
  pendingActions: number;
  onDismiss: () => void;
}) {
  return <ErrorNote message={failureWords(failure, { pendingActions })} detail={failure.detail} onDismiss={onDismiss} />;
}

import type { AssistantEvent } from "@/lib/assistant/loop";
import type { PendingReceipt, RunState } from "@/lib/assistant/runs";
import { STATUS_WORD } from "./AssistantRecord";
import type { LiveTurn } from "./assistant-turn-state";
import type { RecordEntry } from "./record-projection";

/**
 * The status region's sentences: the turn started, each action's start and its outcome, a
 * confirmation's target and consequence, a continuation resuming, the turn's terminal outcome.
 * Sourced from the event sequence the turn hook applies and from the receipt at settlement, never
 * from a rendered snapshot's diff, so a call and its result arriving in one chunk still announce
 * both. Nothing per token. Pure.
 */
export const TURN_STARTED = "Working on your message.";
export const CONTINUING = "Continuing.";

const OUTCOME_WORDS: Partial<Record<RunState, string>> = {
  completed: "Reply complete.",
  interrupted: "Request stopped.",
  failed: "Request failed.",
  unavailable: "Request unavailable.",
};

export function confirmationWords(pending: PendingReceipt): string {
  const target = pending.confirmation?.target ?? "Confirm this action?";
  const consequence = pending.confirmation?.consequence ?? "The action details could not be read. Cancel and try a new message.";
  return `Confirmation required. ${target} ${consequence}`;
}

export function startWords(entry: RecordEntry): string {
  return `${entry.label}: ${STATUS_WORD.running}.`;
}

export function outcomeWords(entry: RecordEntry): string {
  const word = STATUS_WORD[entry.status];
  const detail = entry.status === "succeeded" && entry.elapsed ? `, ${entry.elapsed}` : entry.failure ? `. ${entry.failure.message}` : "";
  return `${entry.label}: ${word}${detail}${detail.endsWith(".") ? "" : "."}`;
}

export function terminalWords(state: RunState): string | null {
  return OUTCOME_WORDS[state] ?? null;
}

/** What one stream event announces, read from the turn it produced. */
export function eventAnnouncements(next: LiveTurn, event: AssistantEvent): string[] {
  if (event.type === "tool_call") {
    const entry = next.actions.find((a) => a.id === event.id);
    return entry ? [entry.status === "running" ? startWords(entry) : outcomeWords(entry)] : [];
  }
  if (event.type === "tool_result") {
    const entry = next.actions.find((a) => a.id === event.id);
    return entry ? [outcomeWords(entry)] : [];
  }
  if (event.type === "confirm_required" && next.pending) return [confirmationWords(next.pending)];
  return [];
}

/** What settlement announces: the outcomes the stream did not carry
 * (a gate ended by Stop, a result lost with the stream) and the turn's
 * terminal outcome. */
export function settlementAnnouncements(streamed: RecordEntry[], settled: RecordEntry[], state: RunState): string[] {
  const seen = new Map(streamed.map((entry) => [entry.id, entry.status]));
  const out = settled.filter((entry) => entry.status !== "running" && seen.get(entry.id) !== entry.status).map(outcomeWords);
  const terminal = terminalWords(state);
  return terminal ? [...out, terminal] : out;
}

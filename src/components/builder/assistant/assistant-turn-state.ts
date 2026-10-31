import type { ModelKnowledge } from "@/lib/assistant/model-knowledge";
import type { ModelChoice } from "./model-choice";
import type { AssistantContext } from "@/lib/assistant/context";
import type { AssistantEvent } from "@/lib/assistant/loop";
import type { PendingReceipt, RunReceipt } from "@/lib/assistant/runs";
import type { ActionDownload } from "./assistant-downloads";
import type { InsertOutcome } from "./ProposalBlock";
import { entryFromAction, entryFromCall, entryFromConfirmation, entryFromResult, type RecordEntry } from "./record-projection";

export type Status = { enabled: true; provider: string; model: string; stepBudget: number; autoCheck?: boolean;
  /** Every model a request may choose on this instance;
   * absent from an instance older than the picker, which is one model. */
  models?: ModelKnowledge[];
  /** Which key pays for this person, and whether the instance has one at all. */
  payer?: { kind: "own" | "instance"; provider: string; lastFour?: string; savedAt?: string };
  instanceKey?: boolean }
  | { enabled: false; reason: string; instanceKey?: boolean } | null;
/** Where a turn's request came from: the page, and for
 * /sql the exact draft the request carried, which Insert compares with. */
export type TurnOrigin = { page: "builder" | "workflow" } | { page: "sql"; draft: string };
export interface Turn {
  role: "user" | "assistant"; text: string; downloads?: ActionDownload[]; runId?: string;
  /** The turn's action record, kept under it after settlement and after
   * later turns; a settled decision's entry included. */
  entries?: RecordEntry[];
  origin?: TurnOrigin;
  /** How each SQL proposal, by its block's index in the reply, was inserted. */
  inserted?: Record<number, InsertOutcome>;
}
export function originOf(context: AssistantContext | undefined): TurnOrigin | undefined {
  if (!context) return undefined;
  return context.page === "sql" ? { page: "sql", draft: context.draft } : { page: context.page };
}
export interface LiveTurn {
  /** The submitted message, in the transcript from submission on (spec
   * item 3), and the run it was bound to once the reservation returned;
   * the settled turn carries both afterwards. */
  message?: string;
  origin?: TurnOrigin;
  runId?: string;
  /** The model and effort this run is bound to: what the
   * picker reads while the run owns it, rather than the next message's
   * selection, which may already have moved on. A recovered run takes it
   * from its receipt; a run with none — one started before the picker, or
   * by a client that sent no choice — displays nothing of its own. */
  choice?: ModelChoice;
  text: string;
  /** The turn's record entries, in order. */
  actions: RecordEntry[];
  pending: PendingReceipt | null;
  segment?: { id: string; start: number };
}
export const emptyTurn = (): LiveTurn => ({ text: "", actions: [], pending: null });
export function receiveEvent(state: LiveTurn, event: AssistantEvent, runId: string): LiveTurn {
  if (event.type === "text_delta") {
    const continuing = state.segment?.id === event.messageId;
    const text = state.text + (!continuing && state.text ? "\n\n" : "");
    const segment = continuing ? state.segment : { id: event.messageId, start: text.length };
    return { ...state, segment, text: text + event.text };
  }
  if (event.type === "message") return { ...state, segment: undefined,
    text: event.messageId && state.segment?.id === event.messageId
      ? state.text.slice(0, state.segment.start) + event.text : state.text + (state.text ? "\n\n" : "") + event.text };
  if (event.type === "confirm_required") return { ...state, pending: { ...event, runId } };
  if (event.type === "tool_call") return { ...state, actions: [...state.actions, entryFromCall(event)] };
  if (event.type === "tool_result") {
    const prior = state.actions.find((a) => a.id === event.id);
    const entry = entryFromResult(prior, event);
    // Where the observation will begin: the turn's text as it stands when
    // the check settles, the receipt's own rule.
    const settled = entry.observation ? { ...entry, observation: { ...entry.observation, at: state.text.length } } : entry;
    return { ...state, actions: [...state.actions.filter((a) => a.id !== event.id), settled] };
  }
  if (event.type === "observation") {
    return { ...state, actions: state.actions.map((a) => a.id === event.id && a.observation
      ? { ...a, observation: { ...(a.observation.at !== undefined ? { at: a.observation.at } : {}), state: event.state, ...(event.text !== undefined ? { text: event.text } : {}), ...(event.reason ? { reason: event.reason } : {}) } }
      : a) };
  }
  return state;
}
/** A receipt's entries: its actions in order, then the settled gates that
 * have no action of their own: the confirmations a newer message
 * superseded, and an approved or declined gate whose continuation
 * stopped before its call ran, so no action carries its call id. A gate
 * whose call did run is already among the actions with its decision. */
export function recoveredTurn(receipt: RunReceipt): LiveTurn {
  const ran = new Set(receipt.actions.map((action) => action.id));
  const settled = (receipt.confirmations ?? [])
    .filter((record) => record.decision === "superseded" || !(record.callId && ran.has(record.callId)))
    .flatMap((record) => { const entry = entryFromConfirmation(record, false); return entry ? [entry] : []; });
  const requested = receipt.provenance?.requested;
  return { text: receipt.text, pending: receipt.pending ?? null,
    ...(requested ? { choice: { model: requested.model, effort: requested.effort } } : {}),
    actions: [...receipt.actions.map(entryFromAction), ...settled] };
}
export function completedTurns(runId: string, message: string, live: LiveTurn, origin?: TurnOrigin): Turn[] {
  const downloads = live.actions.flatMap((a) => a.status === "succeeded" && a.download ? [a.download] : []);
  return [...(message ? [{ role: "user" as const, text: message, runId, ...(origin ? { origin } : {}) }] : []),
    { role: "assistant", text: live.text || "(no reply)", runId, ...(downloads.length ? { downloads } : {}),
      ...(live.actions.length ? { entries: live.actions } : {}), ...(origin ? { origin } : {}) }];
}


/**
 * Where the person's words are after a submission fails: a refusal can
 * arrive after the pane fell back, and the words are never lost either
 * way, only held in one place rather than two.
 *
 * A run reserved under this very message already put the message in the
 * transcript with its run, and the failure is reported beside it there.
 * With no run of its own — nothing reserved, or a reservation that belongs
 * to an older message — the provisional turn goes and the words return to
 * the draft, so a retry is the person's deliberate act rather than a
 * duplicate the pane sent.
 */
export function messageAfterFailure(active: { id: string; message: string } | null, message: string): "transcript" | "draft" {
  return active && active.message === message ? "transcript" : "draft";
}

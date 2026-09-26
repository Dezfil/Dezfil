import type { AssistantEvent } from "@/lib/assistant/loop";
import type { Observation } from "@/lib/assistant/observation";
import type { ConfirmationRecord, Decision, HistoryAssociation, RecoveredLookFacts, RecoveryAction } from "@/lib/assistant/runs";
import { downloadFor, type ActionDownload } from "./assistant-downloads";
import { formatElapsed } from "./talking-about";

/**
 * The record's projection: one pure rule turning a live event, a
 * recovery action or a settled confirmation into the entry the pane
 * shows. Nothing here reads a resource or keeps a list of operations:
 * the words come from the server's record, composed when the action
 * happened, so a live turn and a recovered one project to the same
 * entry. What the bound omitted is marked, never shown as empty; a
 * failure's own text survives with its code, for the rendering boundary
 * to word.
 */

export type EntryStatus = "running" | "succeeded" | "accepted" | "refused" | "uncertain";
export interface EntryFailure { code: string; message: string }
export interface RecordEntry {
  id: string;
  tool: string;
  /** The line's words: the operation's declared verb with its subject. */
  label: string;
  status: EntryStatus;
  /** Execution time, worded, once known. */
  elapsed?: string;
  /** A refusal's own coded text, or an uncertain outcome's. */
  failure?: EntryFailure;
  jobId?: string;
  /** Exactly the SQL the action submitted, when it carried one. */
  sql?: string;
  /** The other retained inputs, in the call's own order. */
  inputs: [string, string][];
  /** The bound dropped this action's detail; nothing is shown as what ran. */
  omitted: boolean;
  history?: HistoryAssociation;
  decision?: Decision;
  download?: ActionDownload;
  /** A map check's facts, for the note and its inspection. */
  check?: CheckFacts;
  /** The check's observation with its lifecycle state. */
  observation?: Observation;
  /** The loop scheduled this check itself. */
  automatic?: boolean;
}

/** What the note and its inspection show of a check: identity, state
 * identity, appearance, sizes, the credit and the composed-in failures. */
export interface CheckFacts {
  renderId: string;
  mapId: string;
  appearance: string;
  stateDigest: string;
  layers?: number;
  widgets?: number;
  image: { width: number; height: number; bytes: number } | null;
  source: { width: number; height: number };
  attribution: string;
  failures: string[];
  /** Hosts of external requests abandoned past the per-request budget, one entry per request. */
  abandoned: string[];
}

/** The counts are absent when the receipt's compaction dropped the
 * detail lists: the inspection then says so, never zero. */
export function checkFactsOf(render: RecoveredLookFacts): CheckFacts {
  return {
    renderId: render.id, mapId: render.mapId, appearance: render.appearance, stateDigest: render.state.digest,
    ...(render.state.layers ? { layers: render.state.layers.length } : {}),
    ...(render.state.widgets ? { widgets: render.state.widgets.length } : {}),
    image: render.image, source: render.source, attribution: render.attribution, failures: render.composition.failures, abandoned: render.composition.abandoned,
  };
}

export const UNCERTAIN: EntryFailure = { code: "assistant_action_uncertain", message: "The outcome is uncertain. Check the affected data." };
const REFUSED: EntryFailure = { code: "refused", message: "The action was refused." };
export const DECLINED_NOTE = "You cancelled it, so this was not done.";
/** A gate the API records as superseded: a newer message from a headless
 * client, or the pane's Stop on a parked turn read back after a reload;
 * the wording is true for either. */
export const SUPERSEDED_NOTE = "The request ended before this was confirmed, so it was not done.";
/** The pane's own words when its Stop ended the parked turn. */
export const STOPPED_NOTE = "You stopped the request, so this was not done.";
/** An approved gate whose continuation stopped before its call ran. */
export const APPROVED_NOT_RUN_NOTE = "Confirmed by you, but the request stopped before it ran, so this was not done.";

const compact = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? String(value);

/** Every retained input but the SQL, which has its own place. */
export function inputsOf(args: Record<string, unknown> | undefined): [string, string][] {
  if (!args) return [];
  return Object.entries(args).filter(([key, value]) => key !== "sql" && value !== undefined).map(([key, value]) => [key, compact(value)]);
}

function failureOf(body: unknown, outcome: EntryStatus): EntryFailure | undefined {
  if (outcome === "uncertain") return UNCERTAIN;
  if (outcome !== "refused") return undefined;
  const record = body as { error?: { code?: unknown; message?: unknown }; note?: unknown } | null;
  const code = typeof record?.error?.code === "string" ? record.error.code : REFUSED.code;
  const message = typeof record?.error?.message === "string" ? record.error.message : typeof record?.note === "string" ? record.note : REFUSED.message;
  return { code, message };
}

type CallEvent = Extract<AssistantEvent, { type: "tool_call" }>;
type ResultEvent = Extract<AssistantEvent, { type: "tool_result" }>;

export function entryFromCall(event: CallEvent): RecordEntry {
  return {
    id: event.id, tool: event.tool, label: event.label ?? event.tool, status: "running",
    ...(typeof event.args.sql === "string" ? { sql: event.args.sql } : {}),
    inputs: inputsOf(event.args), omitted: false, download: downloadFor(event.tool, event.args),
  };
}

export function entryFromResult(prior: RecordEntry | undefined, event: ResultEvent): RecordEntry {
  const status: EntryStatus = event.outcome ?? (event.ok ? "succeeded" : "refused");
  const args = event.args ?? undefined;
  const failure = event.decision === "declined" ? { code: "declined", message: DECLINED_NOTE } : failureOf(event.body, status);
  return {
    id: event.id, tool: event.tool, label: event.label ?? prior?.label ?? event.tool, status,
    ...(event.elapsedMs !== undefined ? { elapsed: formatElapsed(event.elapsedMs) } : {}),
    ...(failure ? { failure } : {}),
    ...(event.jobId ? { jobId: event.jobId } : {}),
    ...(prior?.sql !== undefined ? { sql: prior.sql } : typeof args?.sql === "string" ? { sql: args.sql } : {}),
    inputs: prior?.inputs.length ? prior.inputs : inputsOf(args),
    omitted: false,
    ...(event.history ? { history: event.history } : {}),
    ...(event.decision ? { decision: event.decision } : {}),
    ...(event.ok ? { download: prior?.download ?? downloadFor(event.tool, args ?? {}) } : {}),
    // A check's facts land with its result; its observation is awaited from
    // here, the offset filled by the live turn's state.
    ...(event.render && event.ok ? { check: checkFactsOf(event.render), observation: { state: "awaited" as const } } : {}),
    ...(event.automatic ? { automatic: true } : {}),
  };
}

export function entryFromAction(action: RecoveryAction): RecordEntry {
  const status: EntryStatus = action.status === "attempted" ? "running" : action.status;
  const failure = status === "uncertain" ? UNCERTAIN : status === "refused" ? REFUSED : undefined;
  return {
    id: action.id, tool: action.tool, label: action.label ?? action.tool, status,
    ...(action.elapsedMs !== undefined ? { elapsed: formatElapsed(action.elapsedMs) } : {}),
    ...(failure ? { failure } : {}),
    ...(action.jobId ? { jobId: action.jobId } : {}),
    ...(typeof action.args?.sql === "string" ? { sql: action.args.sql } : {}),
    inputs: inputsOf(action.args),
    omitted: action.omitted === true,
    ...(action.history ? { history: action.history } : {}),
    ...(action.decision ? { decision: action.decision } : {}),
    ...(status === "succeeded" && action.args ? { download: downloadFor(action.tool, action.args) } : {}),
    ...(action.render ? { check: checkFactsOf(action.render) } : {}),
    ...(action.observation ? { observation: action.observation } : {}),
    ...(action.automatic ? { automatic: true } : {}),
  };
}

/** A declined or superseded confirmation is an entry of its own: the
 * action that was not done, in the gate's own words. An approved one is
 * the action's entry, with its real outcome; when no action carries its
 * call (the continuation stopped before the call ran), it is an entry
 * of its own too, confirmed and not done. */
export function entryFromConfirmation(record: ConfirmationRecord, ran = record.decision === "approved"): RecordEntry | undefined {
  if (record.decision === "approved" && ran) return undefined;
  const target = record.confirmation?.target.replace(/\?\s*$/, "") ?? record.tool;
  return {
    id: `confirmation:${record.id}`, tool: record.tool, label: target, status: "refused",
    failure: record.decision === "approved" ? { code: "approved_not_run", message: APPROVED_NOT_RUN_NOTE }
      : { code: record.decision, message: record.decision === "declined" ? DECLINED_NOTE : SUPERSEDED_NOTE },
    ...(typeof record.args?.sql === "string" ? { sql: record.args.sql } : {}),
    inputs: inputsOf(record.args), omitted: record.omitted === true, decision: record.decision,
  };
}

/** On settlement the receipt is the authority for identities, outcomes,
 * words, times and history, but it never carries a result body, so a
 * refusal's own text lives only on the stream this tab saw. The settled
 * entries keep that text where the receipt has only the generic
 * refusal; a recovery in another tab, or after a reload, shows the
 * generic one, which is what the bound allows. */
export function mergeLiveDetail(recovered: RecordEntry[], live: RecordEntry[]): RecordEntry[] {
  const seen = new Map(live.map((entry) => [entry.id, entry]));
  return recovered.map((entry) => {
    const streamed = seen.get(entry.id);
    if (!streamed?.failure || (entry.failure && entry.failure.code !== "refused")) return entry;
    return entry.failure ? { ...entry, failure: streamed.failure } : entry;
  });
}

/** The pane stopped a parked turn: the gate the API
 * settled as superseded on the abandonment is worded for what happened. */
export function wordStoppedGate(entries: RecordEntry[], pendingId: string | null): RecordEntry[] {
  if (!pendingId) return entries;
  return entries.map((entry) => entry.id === `confirmation:${pendingId}` && entry.decision === "superseded"
    ? { ...entry, failure: { code: "stopped", message: STOPPED_NOTE } }
    : entry);
}

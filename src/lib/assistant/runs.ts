import { registerAssistantStore } from "./retained-work";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { getAccount } from "@/lib/metadata/accounts";
import type { ActionEffects, ResolvedConfirmation } from "./action-metadata";
import type { RecordedSubject } from "./record-label";
import { RECOVERY_LIMITS, compactReceipt, jsonBytes, parkedBytes, recoveryLimit } from "./recovery-data";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import type { AssistantEvent } from "./loop";
import type { LookFacts, LookState } from "@/lib/export/map-look";
import type { Observation } from "./observation";

export type RunState = "reserved" | "running" | "awaiting_confirmation" | "completed" | "interrupted" | "failed" | "unavailable";
/** Where a change qualifies for a map's history, the map and
 * the change group the turn stamped. A group is the turn's marker, never
 * a claim that it is one currently undoable step. */
export interface HistoryAssociation { mapId: string; group: string }
export type Decision = "approved" | "declined" | "superseded";
export interface RecoveryAction {
  effects?: ActionEffects;
  jobId?: string;
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  status: "attempted" | "succeeded" | "refused" | "uncertain" | "accepted";
  /** The record's line for this action, composed from the operation's
   * declared display when the action happened. */
  label?: string;
  /** The subject as resolved at the time of the action. */
  subject?: RecordedSubject;
  /** Execution time in milliseconds, measured around the dispatch alone:
   * time waiting at a gate is never inside it. */
  elapsedMs?: number;
  history?: HistoryAssociation;
  /** The decision that let this gated call run, or refused it. */
  decision?: Extract<Decision, "approved" | "declined">;
  /** Set by the terminal compaction when it dropped this action's
   * arguments: the detail is unavailable, not absent. */
  omitted?: true;
  /** A map check's facts: identity, state identity,
   * appearance and sizes; never bytes. */
  render?: RecoveredLookFacts;
  /** The observation attached to a check, with its
   * lifecycle state; absence alone never means the model was silent. */
  observation?: Observation;
  /** The loop scheduled this check itself. */
  automatic?: true;
}
/** A check's facts as a receipt keeps them: the terminal compaction may
 * drop the state identity's detail lists (the layers, the legend order,
 * the widgets), which are then absent, never empty, so a dropped list is
 * distinguishable from a map with nothing visible. */
export type RecoveredLookFacts = Omit<LookFacts, "state"> & {
  state: Omit<LookState, "layers" | "legend" | "widgets"> & { layers?: LookState["layers"]; legend: Omit<LookState["legend"], "order"> & { order?: string[] }; widgets?: string[] };
};
export interface PendingReceipt {
  effects?: ActionEffects; confirmation?: ResolvedConfirmation; id: string; runId: string; tool: string; args: Record<string, unknown>;
  /** The tool-call id the gate holds: the action it runs as on approval. */
  callId?: string;
}
/** A settled confirmation, kept when its pending representation goes
 * approval and decline through a resolution, supersession through a
 * newer message or a release. */
export interface ConfirmationRecord extends Omit<PendingReceipt, "args"> {
  decision: Decision;
  /** The exact call as presented; dropped by the terminal compaction, which then marks it. */
  args?: Record<string, unknown>;
  /** Set by the terminal compaction when it dropped this gate's arguments. */
  omitted?: true;
}
/** What the record says about the model choice:
 * two facts that are never collapsed. What the submission asked for is
 * known before any answer exists; what completed responses reported is a
 * separate later fact, and a response that reported no identity stays
 * distinguishable from one that did. A requested setting is never evidence
 * of the reasoning work a provider actually did. */
export interface RunProvenance {
  /** The pair the run bound, with the halves the instance supplied rather
   * than the person. The effort is the provider-default entry's own word
   * when none was chosen. */
  requested?: { model: string; effort: string; defaulted: { model: boolean; effort: boolean } };
  /** The distinct identities completed provider responses reported, in
   * first-seen order; `null` is a response that completed reporting none.
   * Absent means no provider response completed at all — a failure before
   * any answer, never a response that named nothing. */
  reported?: (string | null)[];
}
export interface RunReceipt {
  id: string; state: RunState; text: string; actions: RecoveryAction[]; incomplete: boolean;
  pending?: PendingReceipt;
  confirmations?: ConfirmationRecord[];
  error?: { code: string; message: string };
  /** The model choice this run was bound to and what its provider answers
   * reported. */
  provenance?: RunProvenance;
}
interface RunEntry { scope: AccountScope; accountId: string; controller?: AbortController; currentText?: { id: string; start: number }; receipt: RunReceipt; fingerprint?: string; createdAt: number }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
interface RunStoreState { entries: Map<string, RunEntry>; terminals: string[] }
export class AssistantRunStore {
  constructor(private now: () => number = Date.now, private readonly state: RunStoreState = { entries: new Map(), terminals: [] }) {}
  private get entries() { return this.state.entries; }
  private get terminals() { return this.state.terminals; }
  private set terminals(value: string[]) { this.state.terminals = value; }
  private expire() {
    for (const [id, entry] of this.entries) {
      if (entry.receipt.state === "reserved" && this.now() - entry.createdAt >= RECOVERY_LIMITS.reservationMs) {
        entry.receipt.state = "unavailable"; this.retainTerminal(id);
      }
    }
  }
  private retainTerminal(id: string) {
    const entry = this.entries.get(id)!;
    entry.receipt = compactReceipt(entry.receipt, RECOVERY_LIMITS.receiptBytes, true);
    if (!this.terminals.includes(id)) this.terminals.push(id);
    while (this.terminals.length > RECOVERY_LIMITS.receipts) this.entries.delete(this.terminals.shift()!);
  }
  reserve(scope: AccountScope): RunReceipt {
    const accountId = requireAccountScope(scope);
    this.expire();
    const occupied = [...this.entries.values()].filter(({ receipt }) => ["reserved", "running", "awaiting_confirmation"].includes(receipt.state)).length;
    if (occupied >= RECOVERY_LIMITS.slots) throw new ApiError("assistant_capacity", ERROR_CATALOGUE.assistant_capacity, 409);
    const receipt: RunReceipt = { id: randomUUID(), state: "reserved", text: "", actions: [], incomplete: false };
    this.entries.set(receipt.id, { receipt, scope, accountId, createdAt: this.now() });
    return structuredClone(receipt);
  }
  requireAccount(scope: AccountScope, id: string): void { this.lookup(scope, id); }
  read(scope: AccountScope, id: string): RunReceipt { return structuredClone(this.lookup(scope, id).receipt); }
  pending(scope: AccountScope): PendingReceipt[] {
    const accountId = requireAccountScope(scope);
    this.expire();
    return structuredClone([...this.entries.values()].flatMap(entry => entry.receipt.pending && entry.accountId === accountId ? [entry.receipt.pending] : []));
  }
  release(scope: AccountScope, id: string): string | undefined {
    const receipt = this.lookup(scope, id).receipt;
    if (receipt.state !== "reserved" && receipt.state !== "awaiting_confirmation") throw new ApiError("assistant_run_state", ERROR_CATALOGUE.assistant_run_state, 409);
    const pendingId = receipt.pending?.id;
    receipt.state = pendingId ? "interrupted" : "unavailable";
    // No provider request follows a released park: a check still awaiting
    // its observation records the interruption.
    for (const action of receipt.actions) if (action.observation?.state === "awaited") action.observation = { ...action.observation, state: "interrupted", reason: "cancelled" };
    this.settle(receipt, "superseded");
    this.retainTerminal(id);
    return pendingId;
  }
  /** Reserve space before admission, including the protected terminal receipt.
   * Result bodies never enter recovery; 4 KiB per action remains for outcome metadata. */
  admit(scope: AccountScope, id: string, call: { id: string; name: string; args: Record<string, unknown> }) {
    const receipt = structuredClone(this.lookup(scope, id).receipt);
    receipt.actions.push({ id: call.id, tool: call.name, args: call.args, status: "attempted" });
    const compact = compactReceipt(receipt, RECOVERY_LIMITS.liveBytes, false);
    // The terminal projection: no action's or settled gate's arguments
    // survive it, so an admitted gate can always settle within the bound.
    const terminal = { ...compact, text: "", actions: compact.actions.map(({ args, ...identity }) => { void args; return identity; }),
      ...(compact.confirmations ? { confirmations: compact.confirmations.map(({ args, ...identity }) => { void args; return identity; }) } : {}) };
    if (jsonBytes(terminal) + 4096 > RECOVERY_LIMITS.receiptBytes) recoveryLimit();
  }
  checkPark(scope: AccountScope, id: string, data: unknown) {
    if (parkedBytes(data) + jsonBytes(this.lookup(scope, id).receipt) > RECOVERY_LIMITS.liveBytes) recoveryLimit();
  }
  /** Synchronous claim before the first await: two callers cannot both win. */
  bind(scope: AccountScope, id: string, input: unknown): boolean {
    const entry = this.lookup(scope, id);
    const fingerprint = createHash("sha256").update(canonical(input)).digest("hex");
    if (entry.fingerprint !== undefined) {
      if (entry.fingerprint !== fingerprint) throw new ApiError("assistant_run_conflict", ERROR_CATALOGUE.assistant_run_conflict, 409);
      return false;
    }
    if (entry.receipt.state !== "reserved") throw new ApiError("assistant_run_unavailable", ERROR_CATALOGUE.assistant_run_unavailable, 404);
    entry.fingerprint = fingerprint; entry.receipt.state = "running"; entry.controller = new AbortController();
    return true;
  }
  /** The choice the accepted submission bound, written
   * before any provider request exists, so a run that fails before any
   * answer still says truthfully what it asked for. */
  bindChoice(scope: AccountScope, id: string, choice: { model: string; effort: string; defaulted: { model: boolean; effort: boolean } }) {
    const receipt = this.lookup(scope, id).receipt;
    (receipt.provenance ??= {}).requested = { model: choice.model, effort: choice.effort, defaulted: { ...choice.defaulted } };
  }
  /** A completed provider response and the identity it reported,
   * written at the provider-completion seam: a reply that only
   * called a tool and an observation that completed silently are recorded
   * exactly like a reply with text. A run the store no longer holds records
   * nothing. An inactive account refuses before any new fact is retained. */
  reported(scope: AccountScope, id: string, model?: string) {
    const accountId = requireAccountScope(scope);
    const entry = this.entries.get(id);
    if (!entry || entry.accountId !== accountId) return;
    const seen = ((entry.receipt.provenance ??= {}).reported ??= []);
    const identity = model ?? null;
    if (!seen.includes(identity)) seen.push(identity);
  }
  /** A resolution re-enters the run; the pending representation becomes a
   * settled record carrying the decision. */
  resume(scope: AccountScope, id: string, decision: Extract<Decision, "approved" | "declined"> = "approved") {
    const entry = this.lookup(scope, id); entry.controller = new AbortController(); entry.receipt.state = "running";
    this.settle(entry.receipt, decision);
  }
  private settle(receipt: RunReceipt, decision: Decision) {
    if (!receipt.pending) return;
    (receipt.confirmations ??= []).push({ ...receipt.pending, decision });
    delete receipt.pending;
  }
  signal(scope: AccountScope, id: string): AbortSignal { return (this.lookup(scope, id).controller ??= new AbortController()).signal; }
  cancel(scope: AccountScope, id: string) {
    const entry = this.lookup(scope, id);
    if (entry.receipt.state === "running") entry.controller?.abort(new DOMException("Execution departed", "AbortError"));
  }
  record(scope: AccountScope, id: string, event: AssistantEvent) {
    const entry = this.lookup(scope, id);
    const receipt = structuredClone(entry.receipt);
    if (event.type === "text_delta") {
      if (entry.currentText?.id !== event.messageId) {
        if (receipt.text) receipt.text += "\n\n";
        entry.currentText = { id: event.messageId, start: receipt.text.length };
      }
      receipt.text += event.text;
    }
    if (event.type === "message") {
      if (event.messageId && entry.currentText?.id === event.messageId) receipt.text = receipt.text.slice(0, entry.currentText.start) + event.text;
      else receipt.text += (receipt.text ? "\n\n" : "") + event.text;
      delete entry.currentText;
    }
    if (event.type === "tool_call") receipt.actions.push({ id: event.id, tool: event.tool, args: event.args, effects: event.effects, status: "attempted", ...(event.label ? { label: event.label } : {}), ...(event.subject ? { subject: event.subject } : {}) });
    if (event.type === "tool_result") {
      let action = receipt.actions.findLast((a) => a.id === event.id);
      if (!action) {
        action = { id: event.id, tool: event.tool, args: event.args, status: "refused" };
        receipt.actions.push(action);
      }
      if (action) {
        action.status = event.outcome ?? (event.ok ? "succeeded" : "refused"); action.effects = event.effects;
        if (event.jobId) action.jobId = event.jobId;
        if (event.label) action.label = event.label;
        if (event.subject) action.subject = event.subject;
        if (event.elapsedMs !== undefined) action.elapsedMs = event.elapsedMs;
        if (event.history) action.history = event.history;
        if (event.decision) action.decision = event.decision;
        if (event.automatic) action.automatic = true;
        // A check's facts, and its observation awaited from here: the
        // text's length now is where it will begin.
        if (event.render && event.ok) { action.render = event.render; action.observation = { state: "awaited", at: receipt.text.length }; }
      }
    }
    if (event.type === "tool_call" && event.automatic) { const action = receipt.actions.findLast((a) => a.id === event.id); if (action) action.automatic = true; }
    if (event.type === "observation") {
      const action = receipt.actions.findLast((a) => a.id === event.id);
      // A separate later fact: it never changes the recorded execution outcome.
      if (action?.observation) action.observation = { ...(action.observation.at !== undefined ? { at: action.observation.at } : {}), state: event.state, ...(event.text !== undefined ? { text: event.text } : {}), ...(event.reason ? { reason: event.reason } : {}) };
    }
    if ((event.type === "done" && event.reason === "interrupted") || event.type === "error") {
      for (const action of receipt.actions) if (action.observation?.state === "awaited") action.observation = { ...action.observation, state: "interrupted", reason: event.type === "error" ? "failed" : "cancelled" };
    }
    if (event.type === "confirm_required") { receipt.state = "awaiting_confirmation"; receipt.pending = { id: event.id, runId: id, tool: event.tool, args: event.args, effects: event.effects, confirmation: event.confirmation, ...(event.callId ? { callId: event.callId } : {}) }; }
    if (event.type === "done" && event.reason === "interrupted" && receipt.state === "running") receipt.state = "interrupted";
    if (event.type === "error") { receipt.state = "failed"; receipt.error = { code: event.code, message: event.message }; }
    entry.receipt = compactReceipt(receipt, RECOVERY_LIMITS.liveBytes, false);
  }
  finish(scope: AccountScope, id: string) {
    const r = this.lookup(scope, id).receipt;
    if (r.state === "running") r.state = "completed";
    // A run that completed with an observation still awaited: the model said nothing more.
    if (r.state === "completed") for (const action of r.actions) if (action.observation?.state === "awaited") action.observation = { ...action.observation, state: "silent" };
    if (["completed", "interrupted", "failed"].includes(r.state)) this.retainTerminal(id);
  }
  fail(scope: AccountScope, id: string, error: { code: string; message: string }) {
    const r = this.lookup(scope, id).receipt; r.state = "failed"; r.error = { code: error.code, message: error.message };
    for (const action of r.actions) if (action.observation?.state === "awaited") action.observation = { ...action.observation, state: "interrupted", reason: "failed" };
    this.retainTerminal(id);
  }
  private lookup(scope: AccountScope, id: string): RunEntry {
    const accountId = requireAccountScope(scope);
    this.expire();
    const entry = this.entries.get(id);
    if (!entry || entry.accountId !== accountId) throw new ApiError("assistant_run_unavailable", ERROR_CATALOGUE.assistant_run_unavailable, 404);
    return entry;
  }
  /** Narrow terminal bookkeeping: no content can be supplied or returned,
   * and an active owner's run cannot be changed through this path. */
  settleInactive(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || getAccount(entry.accountId)?.status === "active") return false;
    if (entry.receipt.state === "running") {
      entry.controller?.abort(new DOMException("Account is inactive", "AbortError"));
      entry.receipt.state = "interrupted";
      entry.receipt.error = { code: "authentication_required", message: "Sign in to continue." };
      for (const action of entry.receipt.actions) if (action.observation?.state === "awaited") action.observation = { ...action.observation, state: "interrupted", reason: "cancelled" };
      this.retainTerminal(id);
    }
    return true;
  }
  interruptAccount(accountId: string): void { for (const entry of this.entries.values()) if (entry.accountId === accountId) entry.controller?.abort(new DOMException("Account is inactive", "AbortError")); }
  eraseAccount(accountId: string): void {
    for (const [id, entry] of this.entries) if (entry.accountId === accountId) this.entries.delete(id);
    this.terminals = this.terminals.filter(id => this.entries.has(id));
  }
  entriesForTests(accountId: string): string[] { return [...this.entries].filter(([,r]) => r.accountId === accountId).map(([id]) => id); }
  terminalsForTests(accountId: string): string[] { return this.terminals.filter(id => this.entries.get(id)?.accountId === accountId); }
  /** Isolate in-process route fixtures, never exposed by the API. */
  resetForTests() { this.entries.clear(); this.terminals = []; }
}
const runsKey = Symbol.for("dezfil.assistant-runs");
const runsHost = globalThis as typeof globalThis & { [runsKey]?: RunStoreState };
const runsState: RunStoreState = runsHost[runsKey] ??= { entries: new Map(), terminals: [] as string[] };
export const assistantRuns = new AssistantRunStore(Date.now, runsState);

registerAssistantStore({ interrupt: id => assistantRuns.interruptAccount(id), erase: id => assistantRuns.eraseAccount(id) });

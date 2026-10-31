import { assistantBeginMark, assistantWorkEnded, registerAssistantStore } from "./retained-work";
import { withoutWriteRevision } from "./edit-revisions";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import type { ResolvedConfirmation } from "./action-metadata";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { RECOVERY_LIMITS, parkedBytes, recoveryLimit } from "./recovery-data";
import type { AssistantContext } from "./context";
import type { TurnFacts } from "./auto-check";
import type { AssistantPolicy } from "./policy";
import { randomUUID } from "node:crypto";
import type { ProviderExchange, ToolCall, ToolOutcome } from "./provider";

/**
 * Where paused assistant runs wait for their confirmation.
 *
 * A run that reaches a confirmation-gated tool parks its complete in-flight
 * state here under a server-issued pending-action id — the identity a
 * resolution later references. Never a provider tool-call id: those do not
 * survive a fresh exchange, which is how approvals used to bind to nothing.
 * Pending actions are working state, like conversations: in-memory,
 * bounded, gone on container replacement. A resolution that finds nothing
 * answers with a documented stale error — never by replaying the turn.
 */

export interface ParkedRun {
  beginMark?: number;
  /** Account binding only; the resolving request supplies a fresh credential. */
  accountId: string;
  confirmation?: ResolvedConfirmation;
  /** The approved run plan retains its basis through the confirmation wait. */
  runPlanRevision?: string;
  /** The map the gated change belongs to, read with the subject before
   * the pause, for a change whose response names no map. */
  historyMapId?: string;
  runId?: string;
  context?: AssistantContext;
  /** The page action policy the run was bound with:
   * a confirmation continuation admits what the original run admitted. */
  policy: AssistantPolicy;
  /** The names the model has been shown, the offer and what discovery
   * found; the live exchange holds the definitions. */
  offered?: string[];
  discovery?: boolean;
  /** The turn's scheduling facts so far: a
   * continuation decides the automatic check from the whole turn. */
  turn?: TurnFacts;
  /** The live provider exchange, mid-turn. */
  exchange: ProviderExchange;
  /** The model reply's tool-call batch being worked when the run parked. */
  calls: ToolCall[];
  /** Index in `calls` of the gated call awaiting resolution. */
  index: number;
  /** Outcomes of the batch's calls before the gated one. */
  outcomes: ToolOutcome[];
  /** Steps spent so far — the budget spans the pause. */
  steps: number;
  /** The turn's mutation headers (change group): one turn, one undo step. */
  headers: Record<string, string>;
}

export type Resolution = "approved" | "declined" | "superseded";

/** Admission refuses instead of evicting an open confirmation. */
const MAX_PARKED = 8;

/** Resolved ids leave a bounded trace so "already resolved" answers
 * distinctly from "unknown". */
const MAX_TRACE = 256;

interface PendingState { parked: Map<string, ParkedRun>; trace: Map<string, { resolution: Resolution; accountId: string }> }
export class PendingActionStore {
  constructor(private readonly state: PendingState = { parked: new Map(), trace: new Map() }) {}
  private get parked() { return this.state.parked; }
  private get trace() { return this.state.trace; }

  peek(scope: AccountScope, id: string): ParkedRun | undefined {
    const accountId = requireAccountScope(scope), run = this.parked.get(id);
    return run?.accountId === accountId ? run : undefined;
  }

  park(scope: AccountScope, run: Omit<ParkedRun, "accountId">): string {
    const accountId = requireAccountScope(scope);
    const beginMark = run.beginMark ?? assistantBeginMark();
    if (assistantWorkEnded(beginMark)) throw new ApiError("authentication_required", "Sign in to continue.", 401);
    if (this.parked.size >= MAX_PARKED) throw new ApiError("assistant_capacity", ERROR_CATALOGUE.assistant_capacity, 409);
    const { exchange, ...data } = run;
    void exchange;
    if (parkedBytes(data) > RECOVERY_LIMITS.liveBytes) recoveryLimit();
    const id = randomUUID();
    this.parked.set(id, Object.freeze({ ...run, beginMark, headers: withoutWriteRevision(run.headers), accountId }));
    return id;
  }

  /** Claim the pending action for resolution. At most one caller ever
   * receives the run; a repeat claim finds only the trace. */
  claim(scope: AccountScope, id: string, how: "approved" | "declined"): ParkedRun | undefined {
    const run = this.peek(scope, id);
    if (!run) return undefined;
    this.parked.delete(id);
    this.remember(id, how, run.accountId);
    return run;
  }

  /** The implicit decline: a new message names the confirmation it abandons
   * Unknown ids are ignored — the client is abandoning the action either
   * way. */
  supersede(scope: AccountScope, id: string): void {
    const run = this.peek(scope, id);
    if (run && this.parked.delete(id)) { run.exchange.dispose?.(); this.remember(id, "superseded", run.accountId); }
  }

  /** How a no-longer-pending id was resolved, when the trace still holds
   * it — distinguishes "already resolved" from "unknown". */
  resolutionOf(scope: AccountScope, id: string): Resolution | undefined {
    const accountId = requireAccountScope(scope);
    const trace = this.trace.get(id);
    return trace && trace.accountId === accountId ? trace.resolution : undefined;
  }

  holdsExchange(exchange: ProviderExchange): boolean { return [...this.parked.values()].some(run => run.exchange === exchange); }
  endBefore(mark: number): void {
    for (const [id, run] of this.parked) if ((run.beginMark ?? 0) < mark) {
      run.exchange.dispose?.(); this.parked.delete(id); this.remember(id, "superseded", run.accountId);
    }
  }
  eraseAccount(accountId: string): void {
    for (const [id, run] of this.parked) if (run.accountId === accountId) { run.exchange.dispose?.(); this.parked.delete(id); }
    for (const [id, trace] of this.trace) if (trace.accountId === accountId) this.trace.delete(id);
  }
  entriesForTests(accountId: string) { return { parked: [...this.parked].filter(([,r]) => r.accountId === accountId).map(([id]) => id), trace: [...this.trace].filter(([,r]) => r.accountId === accountId).map(([id]) => id) }; }
  resetForTests() { this.parked.clear(); this.trace.clear(); }

  private remember(id: string, how: Resolution, accountId: string): void {
    while (this.trace.size >= MAX_TRACE) {
      const oldest = this.trace.keys().next().value;
      if (oldest === undefined) break;
      this.trace.delete(oldest);
    }
    this.trace.set(id, { resolution: how, accountId });
  }
}

/** The instance's store — module state, shared by the exchange endpoint. */
const pendingKey = Symbol.for("dezfil.pending-actions");
const pendingHost = globalThis as typeof globalThis & { [pendingKey]?: PendingState };
const pendingState: PendingState = pendingHost[pendingKey] ??= { parked: new Map(), trace: new Map() };
export const pendingActions = new PendingActionStore(pendingState);

registerAssistantStore({ endBefore: mark => pendingActions.endBefore(mark), erase: accountId => pendingActions.eraseAccount(accountId) });

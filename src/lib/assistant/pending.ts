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
  confirmation?: ResolvedConfirmation;
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

export class PendingActionStore {
  private parked = new Map<string, ParkedRun>();
  private trace = new Map<string, Resolution>();

  peek(id: string): ParkedRun | undefined { return this.parked.get(id); }

  park(run: ParkedRun): string {
    if (this.parked.size >= MAX_PARKED) throw new ApiError("assistant_capacity", ERROR_CATALOGUE.assistant_capacity, 409);
    const { exchange, ...data } = run;
    void exchange;
    if (parkedBytes(data) > RECOVERY_LIMITS.liveBytes) recoveryLimit();
    const id = randomUUID();
    this.parked.set(id, run);
    return id;
  }

  /** Claim the pending action for resolution. At most one caller ever
   * receives the run; a repeat claim finds only the trace. */
  claim(id: string, how: "approved" | "declined"): ParkedRun | undefined {
    const run = this.parked.get(id);
    if (!run) return undefined;
    this.parked.delete(id);
    this.remember(id, how);
    return run;
  }

  /** The implicit decline: a new message names the confirmation it abandons
   * Unknown ids are ignored — the client is abandoning the action either
   * way. */
  supersede(id: string): void {
    if (this.parked.delete(id)) this.remember(id, "superseded");
  }

  /** How a no-longer-pending id was resolved, when the trace still holds
   * it — distinguishes "already resolved" from "unknown". */
  resolutionOf(id: string): Resolution | undefined {
    return this.trace.get(id);
  }

  resetForTests() { this.parked.clear(); this.trace.clear(); }

  private remember(id: string, how: Resolution): void {
    while (this.trace.size >= MAX_TRACE) {
      const oldest = this.trace.keys().next().value;
      if (oldest === undefined) break;
      this.trace.delete(oldest);
    }
    this.trace.set(id, how);
  }
}

/** The instance's store — module state, shared by the exchange endpoint. */
export const pendingActions = new PendingActionStore();

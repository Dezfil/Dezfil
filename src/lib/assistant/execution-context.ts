import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { limits } from "@/lib/limits";
import { buildTools, type ToolDef } from "@/lib/tools/tools";
import type { ActionContext } from "./action-execution";
import { emptyTurnFacts, type TurnFacts } from "./auto-check";
import type { OfferMode } from "./offer";
import { pendingActions, type PendingActionStore } from "./pending";
import { admittedTools, type AssistantPolicy } from "./policy";
import type { ProviderExchange } from "./provider";
import { assistantTools } from "./tool-surface";

export interface LoopDeps {
  scope: AccountScope;
  runId?: string;
  grounding?: string;
  tools?: ToolDef[];
  baseUrl: string;
  fetchImpl?: typeof fetch;
  stepBudget?: number;
  /** The assistant request's departure — tool calls cancel with it. */
  signal?: AbortSignal;
  /** Where paused runs park; the instance store unless a test injects. */
  pending?: PendingActionStore;
  /** The page action policy; derived from the context
   * when absent, so a caller that passes neither gets today's whole set. */
  policy?: AssistantPolicy;
  /** The offer's mode: the page's subset or the full
   * admitted set; the module default unless a measurement arm sets it. */
  offerMode?: OfferMode;
  /** Whether discovery is offered when the offer omits admitted
   * operations; on unless a measurement control turns it off. */
  discovery?: boolean;
  /** The system prompt, for the measurement's base arm; the composed
   * prompt otherwise. */
  system?: string;
  /** Whether the loop schedules a map check after a qualifying turn
   * the instance setting unless a caller says. */
  autoCheck?: boolean;
}

/** The per-run context, plus the turn's scheduling facts. */
export interface ExecutionContext extends ActionContext {
  turn: TurnFacts;
  /** Whether the loop schedules a map check after a qualifying turn. */
  autoCheck: boolean;
}

export function makeExecutionContext(
  deps: LoopDeps,
  headers: Record<string, string>,
  exchange: ProviderExchange,
  policy: AssistantPolicy,
  offered: Iterable<string>,
  discovery: boolean,
  turn: TurnFacts = emptyTurnFacts(),
): ExecutionContext {
  requireAccountScope(deps.scope);
  const tools = assistantTools(deps.tools ?? buildTools());
  return {
    turn,
    autoCheck: deps.autoCheck ?? limits.assistantAutoCheck,
    runId: deps.runId,
    scope: deps.scope,
    policy,
    admitted: new Set(admittedTools(policy, tools).map((t) => t.name)),
    offered: new Set(offered),
    discovery,
    byName: new Map(tools.map((t) => [t.name, t])),
    budget: deps.stepBudget ?? limits.assistantStepBudget,
    baseUrl: deps.baseUrl,
    fetchImpl: deps.fetchImpl,
    signal: deps.signal,
    headers,
    store: deps.pending ?? pendingActions,
    exchange,
  };
}

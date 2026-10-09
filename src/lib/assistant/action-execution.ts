import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { ApiError } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";
import { executeTool, elideAttachment } from "@/lib/tools/execute";
import type { ToolDef } from "@/lib/tools/tools";
import { actionEffects, actionOutcome, historyAssociation } from "./action-metadata";
import { composeLabel, recordedSubject, type RecordedSubject } from "./record-label";
import type { AssistantContext } from "./context";
import type { AssistantEvent } from "./loop";
import type { PendingActionStore } from "./pending";
import type { AssistantPolicy } from "./policy";
import type { ProviderExchange, ToolCall } from "./provider";
import type { Decision } from "./runs";
import { callPath, type AssistantRevisions } from "./edit-revisions";
import { shapeLookOutcome } from "./look-outcome";
import { recordedArguments } from "./recorded-arguments";

/**
 * The execution and recording of one admitted action, out of the loop:
 * the call is dispatched to the documented API through the tool layer,
 * its outcome is worded from the operation's declaration, the events the
 * record and the receipt read are emitted, and the outcome the model
 * reads joins the batch. The loop keeps admission, the gate and the step
 * budget; this module knows nothing about either.
 */

/** Per-run context: everything a step needs that is not batch state. */
export interface ActionContext {
  scope: AccountScope;
  runId?: string;
  context?: AssistantContext;
  policy: AssistantPolicy;
  /** The names the run's policy admits; a call outside them is refused
   * before any product operation, whatever the model was shown. */
  admitted: Set<string>;
  /** The names the model has been shown: the offer plus what discovery found. */
  offered: Set<string>;
  /** Whether discovery is available to this run. */
  discovery: boolean;
  byName: Map<string, ToolDef>;
  budget: number;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  headers: Record<string, string>;
  revisions: AssistantRevisions;
  store: PendingActionStore;
  exchange: ProviderExchange;
}

/** The batch being worked: mutated in place as calls complete, parked
 * verbatim when a gated call pauses the run. */
export interface ActionBatch {
  calls: ToolCall[];
  index: number;
  outcomes: { toolCallId: string; body: string; isError: boolean }[];
  steps: number;
}

export interface SettledGate {
  decision?: Extract<Decision, "approved">;
  historyMapId?: string;
}

export async function* execAndRecord(
  ctx: ActionContext,
  tool: ToolDef,
  call: ToolCall,
  batch: ActionBatch,
  settled: SettledGate = {},
): AsyncGenerator<AssistantEvent> {
  requireAccountScope(ctx.scope);
  yield { type: "tool_call", id: call.id, tool: call.name, args: recordedArguments(call.args), effects: actionEffects(tool, call.args), ...words(tool, call.args) };
  let result;
  let dispatched = false;
  // Measured around the dispatch alone: a gate's wait ended before this
  // generator was entered, so it is never inside the figure.
  const started = performance.now();
  try {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    dispatched = true;
    result = await executeTool(tool, ctx.revisions.bodyArguments(tool, call.args), ctx.baseUrl, ctx.fetchImpl, { ...ctx.headers, ...ctx.revisions.headers(tool, call.args) },
      actionEffects(tool, call.args).readOnly ? ctx.signal : undefined);
  } catch (error) {
    const uncertain = dispatched && !actionEffects(tool, call.args).readOnly;
    void error;
    const body = { error: { code: uncertain ? "assistant_action_uncertain" : "assistant_action_interrupted", message: uncertain ? "The action outcome could not be established. Its declared resources may have changed." : "The read was interrupted before completion." } };
    yield { type: "tool_result", id: call.id, tool: call.name, ok: false, body, effects: actionEffects(tool, call.args), outcome: uncertain ? "uncertain" : "refused", elapsedMs: Math.round(performance.now() - started), ...words(tool, call.args), ...settledFacts(settled) };
    batch.outcomes.push({ toolCallId: call.id, body: JSON.stringify(body), isError: true });
    // Unknown outcomes are terminal, never a prompt for automatic re-execution.
    throw new ApiError(uncertain ? "assistant_action_uncertain" : "assistant_action_interrupted", body.error.message, 500);
  }
  // Attachment bytes never enter model text: the model sees the
  // envelope's metadata with the content elided; the event stream and MCP
  // clients keep the full envelope.
  requireAccountScope(ctx.scope);
  const elapsedMs = Math.round(performance.now() - started);
  // The map check's image goes to the model natively and to nothing
  // else: the events and the receipt carry the facts alone.
  if (result.ok) ctx.revisions.observe(callPath(tool, call.args), result.body);
  const look = shapeLookOutcome(call.name, result.ok, result.body);
  const modelBody = elideAttachment(look.modelBody);
  const effects = actionEffects(tool, call.args, result.body);
  const outcome = actionOutcome(result, effects);
  const history = result.ok ? historyAssociation(tool, call.args, result.body, ctx.headers[CHANGE_GROUP_HEADER], settled.historyMapId) : undefined;
  yield {
    type: "tool_result",
    id: call.id,
    tool: call.name,
    ok: result.ok,
    body: look.render ? look.eventBody : modelBody,
    effects,
    ...outcome,
    ...(look.outcome ? { outcome: look.outcome } : {}),
    ...words(tool, call.args, result.ok ? result.body : undefined),
    elapsedMs,
    ...(history ? { history } : {}),
    ...settledFacts(settled),
    ...(look.render ? { render: look.render } : {}),
  };
  batch.outcomes.push({
    toolCallId: call.id,
    body:
      typeof modelBody === "string" ? modelBody : JSON.stringify(modelBody),
    isError: !result.ok,
    ...(look.image ? { image: look.image } : {}),
  });
  // Unknown outcomes are terminal however they arose: a mutation the
  // instance answered 5xx is exactly as unknown as one whose dispatch threw,
  // so nothing further from this reply is dispatched and the run ends
  // carrying the uncertain code. The event above keeps the instance's own
  // diagnosis; the throw carries the documented sentence the thrown path
  // already reaches the pane with. Read from the outcome the event recorded,
  // so the two can never disagree.
  if ((look.outcome ?? outcome.outcome) === "uncertain") {
    throw new ApiError("assistant_action_uncertain", ERROR_CATALOGUE.assistant_action_uncertain, 500);
  }
}

/** The record's line and subject for a call, from the operation's
 * declaration; the response refines the subject's name once the action
 * happened. The arguments are read as recorded: an address as scheme and
 * host. */
export function words(tool: ToolDef, given: Record<string, unknown>, body?: unknown): { label: string; subject?: RecordedSubject } {
  const args = recordedArguments(given);
  const subject = recordedSubject(tool.display, args, body);
  // A planning call starts nothing and says so.
  const planned = tool.effects.planningArgument !== undefined && args[tool.effects.planningArgument] === true;
  const verb = planned ? tool.display.planningVerb ?? tool.display.verb : tool.display.verb;
  return { label: composeLabel(tool.display, args, subject, verb), ...(subject ? { subject } : {}) };
}

export function settledFacts(settled: { decision?: Extract<Decision, "approved"> }) {
  return settled.decision ? { decision: settled.decision } : {};
}

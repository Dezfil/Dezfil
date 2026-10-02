import { AuthError } from "@/lib/auth/errors";
import { requireAccountScope } from "@/lib/auth/scope";
import { assistantTools, assistantCall } from "./tool-surface";
import { streamReply } from "./provider-step";
import { ApiError } from "@/lib/api/errors";
import { prepareConfirmation } from "./confirmation";
import { actionEffects, noEffects, subjectFacts, type ActionEffects, type ResolvedConfirmation } from "./action-metadata";
import { execAndRecord, words, type ActionBatch as Batch } from "./action-execution";
import { decideAutomaticCheck, emptyTurnFacts, noteTurnEvent, withContextualMap } from "./auto-check";
import { runAutomaticCheck } from "./check-turn";
import { LOOK_TOOL } from "./look-outcome";
import { assistantRuns, type Decision, type HistoryAssociation } from "./runs";
import type { RecordedSubject } from "./record-label";
import type { AssistantContext } from "./context";
import type { LookFacts } from "@/lib/export/map-look";
import { splitObservation, type ObservationReason, type ObservationState } from "./observation";
import { admittedTools, POLICY_REFUSAL_CODE, policyFor } from "./policy";
import { defaultOffer } from "./offer";
import { DISCOVERY_TOOL, discoveryBody, discoveryDefinition, findOperations } from "./discovery";
import { randomUUID } from "node:crypto";
import { buildTools } from "@/lib/tools/tools";
import { CHANGE_GROUP_HEADER } from "@/lib/api/change-group";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { systemPrompt } from "./prompt";
import {
  ProviderError,
  type HistoryTurn,
  type ModelProvider,
  type ProviderReply,
} from "./provider";
import type { ParkedRun } from "./pending";
import { makeExecutionContext, type ExecutionContext, type LoopDeps } from "./execution-context";
export type { LoopDeps } from "./execution-context";

/**
 * The bounded agent loop: the assistant works through tools that are the
 * documented API — a client, never a backdoor. Confirmation-gated tools do
 * not run without an explicit user go-ahead; a documented step budget
 * makes a runaway loop impossible.
 *
 * A run is resumable: reaching a gated tool parks the run's complete
 * in-flight state — exchange, batch position, outcomes, steps, change
 * group — under a server-issued pending-action id, and resolution
 * re-enters the same run where it parked. Nothing before the pause can
 * re-run because nothing restarts; the change group and step budget span
 * the pause because they travel with the parked state; approval executes
 * exactly the presented call because the parked state holds the call
 * itself.
 *
 * The loop yields events so the caller (the exchange endpoint) can stream
 * actions to the builder as they happen and pause for confirmations.
 */

export type AssistantEvent =
  | { type: "message"; text: string; messageId?: string; model?: string }
  | { type: "text_delta"; text: string; messageId: string }
  | {
      effects?: ActionEffects;
      type: "tool_call";
      id: string;
      tool: string;
      args: Record<string, unknown>;
      /** The record's line and subject as known before execution. */
      label?: string;
      subject?: RecordedSubject;
      /** The loop scheduled this check itself. */
      automatic?: true;
    }
  | {
      type: "tool_result"; id: string; tool: string; ok: boolean; body: unknown; args?: Record<string, unknown>; effects?: ActionEffects;
      outcome?: "succeeded" | "accepted" | "refused" | "uncertain"; jobId?: string;
      /** The record's line and subject, resolved when the action happened. */
      label?: string;
      subject?: RecordedSubject;
      /** Execution time around the dispatch alone. */
      elapsedMs?: number;
      /** The map and change group where the change qualifies for history. */
      history?: HistoryAssociation;
      /** For the call a resolution settled: how it was settled. */
      decision?: Extract<Decision, "approved" | "declined">;
      /** A map check's facts, without its bytes. */
      render?: LookFacts;
      /** The loop scheduled this check itself. */
      automatic?: true;
    }
  | {
      /** The turn paused: `id` is the server-issued pending-action id a
       * resolution references — not a provider tool-call id. */
      effects?: ActionEffects;
      confirmation?: ResolvedConfirmation;
      type: "confirm_required";
      id: string;
      tool: string;
      args: Record<string, unknown>;
      /** The provider tool-call id the gate holds, so a settled gate can be
       * matched with the action it ran as, or seen to have run as none.
       * */
      callId?: string;
    }
  | {
      /** The observation attached to a check: a separate
       * later fact, never a change to the check's recorded outcome. */
      type: "observation";
      /** The check action's id. */
      id: string;
      state: ObservationState;
      text?: string;
      reason?: ObservationReason;
    }
  | { type: "error"; code: string; message: string }
  | { type: "done"; reason: "end" | "budget" | "interrupted" };

export interface RunInput {
  context?: AssistantContext;
  message: string;
  history: HistoryTurn[];
}

const CONFIRM_DENIED = "The user did not confirm this action, so it was not performed.";

export async function* runAssistant(
  provider: ModelProvider,
  input: RunInput,
  deps: LoopDeps,
): AsyncGenerator<AssistantEvent> {
  requireAccountScope(deps.scope);
  if (deps.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return; }
  // The policy binds here, at the first accepted submission: the model
  // is offered only what the run admits.
  const policy = deps.policy ?? policyFor(input.context);
  // The offer: the page's operations and the grounding reads inside what
  // the policy admits; discovery is offered whenever admission holds more
  // than the offer, so the rest stays reachable.
  const tools = assistantTools(deps.tools ?? buildTools());
  const offer = defaultOffer(input.context?.page, policy, tools, deps.offerMode);
  const discovery = deps.discovery !== false && offer.length < admittedTools(policy, tools).length;
  const exchange = provider.exchange({
    system: deps.system ?? systemPrompt(),
    grounding: deps.grounding,
    tools: discovery ? [...offer, discoveryDefinition()] : offer,
    history: input.history,
  });
  // Every mutation of this turn carries one group marker, so the whole
  // turn lands as a single undo step — across pauses too, because the
  // marker parks with the run.
  const ctx = makeExecutionContext(deps, { [CHANGE_GROUP_HEADER]: randomUUID() }, exchange, policy, offer.map((t) => t.name), discovery);
  ctx.context = input.context;

  let reply;
  try {
    reply = yield* streamReply(ctx.scope, (options) => exchange.send(input.message, options), ctx.signal, ctx.runId);
  } catch (error) {
    yield ctx.signal?.aborted ? { type: "done", reason: "interrupted" } : errorEvent(error);
    return;
  }
  yield* runFromReply(ctx, reply, 0);
}

/** Re-enter a parked run with its confirmation resolved. The caller has
 * already claimed the run from the store; a decline still resumes — the
 * model hears the documented note and finishes its turn. */
export async function* resumeAssistant(
  parked: ParkedRun,
  approved: boolean,
  deps: LoopDeps,
): AsyncGenerator<AssistantEvent> {
  if (requireAccountScope(deps.scope) !== parked.accountId) throw new ApiError("pending_unknown", "No such pending action. It may have expired with the server's working state.", 404);
  // The parked run's own policy, never the resolving request's: a
  // continuation admits what the original submission admitted.
  const ctx = makeExecutionContext(deps, parked.headers, parked.exchange, parked.policy, parked.offered ?? [], parked.discovery ?? false, parked.turn ?? emptyTurnFacts());
  if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return; }
  ctx.context = parked.context;
  if (deps.grounding !== undefined) ctx.exchange.setGrounding?.(deps.grounding);
  const batch: Batch = {
    calls: parked.calls,
    index: parked.index,
    outcomes: parked.outcomes,
    steps: parked.steps,
  };

  // The resolved call's step was counted when it parked; execute or skip
  // it without spending another.
  const call = batch.calls[batch.index];
  const tool = ctx.byName.get(call.name);
  if (approved && tool) {
    try { await ctx.revisions.readOnResume(tool, call.args, ctx.baseUrl, ctx.fetchImpl ?? fetch, ctx.signal, parked.runPlanRevision); }
    catch (error) { yield ctx.signal?.aborted ? { type: "done", reason: "interrupted" } : errorEvent(error); return; }
    yield* observed(ctx, execAndRecord(ctx, tool, call, batch, { decision: "approved", historyMapId: parked.historyMapId }));
  } else {
    const body = JSON.stringify(
      tool
        ? { note: CONFIRM_DENIED }
        : { error: { code: "invalid_request", message: `Unknown tool: ${call.name}` } },
    );
    yield {
      type: "tool_result",
      id: call.id,
      tool: call.name,
      ok: false,
      body: JSON.parse(body),
      args: call.args, effects: tool ? actionEffects(tool, call.args) : noEffects, outcome: "refused",
      // A declined call is recorded in the gate's own words: what was not done.
      ...(tool ? { decision: "declined" as const, ...words(tool, call.args), ...(parked.confirmation ? { label: parked.confirmation.target.replace(/\?\s*$/, "") } : {}) } : {}),
    };
    batch.outcomes.push({ toolCallId: call.id, body, isError: !tool });
  }
  batch.index += 1;

  if (yield* processCalls(ctx, batch)) return;
  if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return; }
  if (batch.steps >= ctx.budget) {
    yield* observed(ctx, exhausted(ctx));
    yield { type: "done", reason: "budget" };
    return;
  }
  let reply;
  try {
    reply = yield* streamReply(ctx.scope, (options) => ctx.exchange.continueWith(batch.outcomes, options), ctx.signal, ctx.runId);
  } catch (error) {
    yield ctx.signal?.aborted ? { type: "done", reason: "interrupted" } : errorEvent(error);
    return;
  }
  yield* runFromReply(ctx, reply, batch.steps);
}

/** The reply loop: emit text, work the batch, feed outcomes back, repeat
 * until the model stops calling tools or the run parks or exhausts. */
async function* runFromReply(
  ctx: ExecutionContext,
  reply: ProviderReply,
  steps: number,
): AsyncGenerator<AssistantEvent> {
  while (true) {
    requireAccountScope(ctx.scope);
    if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return; }
    if (reply.text) yield { type: "message", text: reply.text, messageId: reply.messageId, ...(reply.model ? { model: reply.model } : {}) };
    // The observation: the first sentence of the text that follows a
    // settled check, a separate fact attached to it.
    yield* observed(ctx, observationOf(ctx, reply.text, reply.toolCalls.length === 0));
    if (reply.toolCalls.length === 0) {
      // The turn ends normally: the one place the automatic check is
      // decided. Its observation reply ends the turn whatever it
      // proposes: nothing after it is dispatched (D7).
      const scheduled = decideAutomaticCheck({ context: ctx.context, facts: ctx.turn, steps, budget: ctx.budget, enabled: ctx.autoCheck });
      if (scheduled) {
        steps += 1;
        try { yield* observed(ctx, runAutomaticCheck(ctx, scheduled)); }
        catch (error) { yield ctx.signal?.aborted ? { type: "done", reason: "interrupted" } : errorEvent(error); return; }
        if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return; }
      }
      yield { type: "done", reason: "end" };
      return;
    }

    const batch: Batch = { calls: reply.toolCalls, index: 0, outcomes: [], steps };
    if (yield* processCalls(ctx, batch)) return;
    steps = batch.steps;
    if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return; }
    if (steps >= ctx.budget) {
      yield* observed(ctx, exhausted(ctx));
      yield { type: "done", reason: "budget" };
      return;
    }

    try {
      reply = yield* streamReply(ctx.scope, (options) => ctx.exchange.continueWith(batch.outcomes, options), ctx.signal, ctx.runId);
    } catch (error) {
      yield ctx.signal?.aborted ? { type: "done", reason: "interrupted" } : errorEvent(error);
      return;
    }
  }
}

/** Work the batch from its current index. Returns true when the run ended
 * here — parked at a gated call or out of budget — with the events already
 * emitted; false when the batch completed. */
async function* processCalls(
  ctx: ExecutionContext,
  batch: Batch,
): AsyncGenerator<AssistantEvent, boolean> {
  while (batch.index < batch.calls.length) {
    if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return true; }
    if (batch.steps >= ctx.budget) {
      yield* observed(ctx, exhausted(ctx));
      yield { type: "done", reason: "budget" };
      return true;
    }
    const incoming = batch.calls[batch.index];
    const raw = assistantCall(incoming, ctx.byName.get(incoming.name));
    batch.calls[batch.index] = raw;
    batch.steps += 1;

    // Discovery: searches the admitted operations the offer omitted and
    // extends this exchange with what it found. No product dispatch, a
    // step spent like any call, admission untouched.
    if (ctx.discovery && raw.name === DISCOVERY_TOOL) {
      const call = raw;
      if (ctx.runId) assistantRuns.admit(ctx.scope, ctx.runId, call);
      const query = typeof call.args.query === "string" ? call.args.query : "";
      const label = `Looked up operations for ${JSON.stringify(query)}`;
      yield { type: "tool_call", id: call.id, tool: call.name, args: call.args, effects: noEffects, label };
      const started = performance.now();
      const candidates = [...ctx.byName.values()].filter((t) => ctx.admitted.has(t.name) && !ctx.offered.has(t.name));
      const found = findOperations(query, candidates);
      for (const tool of found.matches) ctx.offered.add(tool.name);
      ctx.exchange.extendTools?.(found.matches);
      const body = discoveryBody(found);
      yield { type: "tool_result", id: call.id, tool: call.name, ok: true, body, effects: noEffects, outcome: "succeeded", label, elapsedMs: Math.round(performance.now() - started) };
      batch.outcomes.push({ toolCallId: call.id, body: JSON.stringify(body), isError: false });
      batch.index += 1;
      continue;
    }

    // A model-requested check naming no map is aimed at the contextual
    // one; the loop is a client supplying its context.
    const call = raw.name === LOOK_TOOL ? { ...raw, args: withContextualMap(raw.args, ctx.context) } : raw;
    const tool = ctx.byName.get(call.name);
    if (!tool) {
      const body = JSON.stringify({
        error: {
          code: "invalid_request",
          message: `Unknown tool: ${call.name}`,
        },
      });
      yield {
        type: "tool_result",
        id: call.id,
        tool: call.name,
        ok: false,
        body: JSON.parse(body),
        args: call.args, effects: noEffects, outcome: "refused",
      };
      batch.outcomes.push({ toolCallId: call.id, body, isError: true });
      batch.index += 1;
      continue;
    }

    // The page action policy, enforced here before the gate and before
    // any product operation: a call outside the run's admitted set is
    // refused with the documented error and recorded refused, however it
    // arrived.
    if (!ctx.admitted.has(call.name)) {
      const body = { error: { code: POLICY_REFUSAL_CODE, message: ERROR_CATALOGUE.assistant_action_not_admitted } };
      if (ctx.runId) assistantRuns.admit(ctx.scope, ctx.runId, call);
      yield { type: "tool_result", id: call.id, tool: call.name, ok: false, body, args: call.args, effects: actionEffects(tool, call.args), outcome: "refused", ...words(tool, call.args) };
      batch.outcomes.push({ toolCallId: call.id, body: JSON.stringify(body), isError: true });
      batch.index += 1;
      continue;
    }

    // Confirmation gate — enforced here, server-side, so a UI that hides the
    // prompt cannot bypass it. The run parks whole; the pending-action id is
    // what a resolution references.
    //
    // **A conditional confirmation is enforced here too**. One control whose
    // blast radius depends on what it is aimed at declares `when_wide` rather
    // than a boolean, and metadata nothing consults is decoration: without
    // this, a model could run a whole recipe unconfirmed through the one
    // operation that was singled out as needing it. Asking the operation for
    // its own plan is never gated — that is how a caller finds out which case
    // it is in.
    let confirmation: Awaited<ReturnType<typeof prepareConfirmation>>;
    try { confirmation = await prepareConfirmation(tool, call, ctx); }
    catch (error) { yield ctx.signal?.aborted ? { type: "done", reason: "interrupted" } : errorEvent(error); return true; }
    if (ctx.signal?.aborted) { yield { type: "done", reason: "interrupted" }; return true; }
    if (ctx.runId) assistantRuns.admit(ctx.scope, ctx.runId, call);
    if (confirmation) {
      const parked = {
        confirmation: confirmation.words,
        runPlanRevision: confirmation.runPlanRevision,
        historyMapId: subjectFacts(confirmation.subject)?.mapId,
        runId: ctx.runId,
        context: ctx.context,
        policy: ctx.policy,
        offered: [...ctx.offered],
        discovery: ctx.discovery,
        turn: ctx.turn,
        exchange: ctx.exchange,
        calls: batch.calls.map((candidate) => assistantCall(candidate, ctx.byName.get(candidate.name))),
        index: batch.index,
        outcomes: batch.outcomes,
        steps: batch.steps,
        headers: ctx.headers,
      };
      if (ctx.runId) {
        const { exchange, ...data } = parked;
        void exchange;
        assistantRuns.checkPark(ctx.scope, ctx.runId, { ...data, pendingArguments: call.args });
      }
      const id = ctx.store.park(ctx.scope, parked);
      yield { type: "confirm_required", id, tool: call.name, args: call.args, callId: call.id, confirmation: confirmation.words, effects: actionEffects(tool, call.args) };
      yield { type: "done", reason: "end" };
      return true;
    }

    yield* observed(ctx, execAndRecord(ctx, tool, call, batch));
    batch.index += 1;
  }
  return false;
}

/** The observation a reply supplies for the check awaiting one: captured
 * from its first sentence, or completed with no text where the turn
 * ends without any; a reply with calls and no text leaves it awaited. */
async function* observationOf(ctx: ExecutionContext, text: string, ending: boolean): AsyncGenerator<AssistantEvent> {
  const { displayed } = splitObservation(text);
  for (const id of ctx.turn.awaiting ?? []) {
    if (displayed) yield { type: "observation", id, state: "captured", text: displayed };
    else if (ending) yield { type: "observation", id, state: "silent" };
  }
}

/** Spending the last step admits no further request: a check still
 * awaiting its observation records why none will come. */
async function* exhausted(ctx: ExecutionContext): AsyncGenerator<AssistantEvent> {
  for (const id of ctx.turn.awaiting ?? []) yield { type: "observation", id, state: "interrupted", reason: "exhausted" };
}

/** Forward an action's events, folding each into the turn's facts. */
async function* observed<R>(ctx: ExecutionContext, events: AsyncGenerator<AssistantEvent, R>): AsyncGenerator<AssistantEvent, R> {
  for (;;) {
    const next = await events.next();
    if (next.done) return next.value;
    ctx.turn = noteTurnEvent(ctx.turn, next.value, ctx.context);
    yield next.value;
  }
}

function errorEvent(error: unknown): AssistantEvent {
  if (error instanceof ApiError || error instanceof AuthError) return { type: "error", code: error.code, message: error.message };
  if (error instanceof ProviderError) {
    return {
      type: "error",
      code: error.kind === "auth" ? "assistant_auth" : "assistant_provider",
      message: error.message,
    };
  }
  // An unexpected failure crosses no internals: the event carries the
  // documented sentence; the detail goes to the log.
  console.error("[assistant] unexpected loop error:", error);
  return {
    type: "error",
    code: "internal",
    message: ERROR_CATALOGUE.internal,
  };
}

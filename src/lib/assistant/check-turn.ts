import { randomUUID } from "node:crypto";
import { executeTool } from "@/lib/tools/execute";
import type { ActionContext } from "./action-execution";
import { actionOutcome, noEffects } from "./action-metadata";
import type { ScheduledCheck } from "./auto-check";
import type { AssistantEvent } from "./loop";
import { LOOK_TOOL, shapeLookOutcome } from "./look-outcome";
import { splitObservation } from "./observation";
import { streamReply } from "./provider-step";
import type { ProviderReply } from "./provider";
import { assistantRuns } from "./runs";

/**
 * The automatic check's run: one dispatch of the documented check aimed
 * at the contextual map, recorded as an action the loop scheduled itself,
 * then one image-bearing continuation whose reply is the observation and
 * ends the turn. The reply's tool calls, if it makes any, are never
 * dispatched: the loop's boundary, not a sentence to the model, is what
 * keeps the observation from starting further work (D7). A check that
 * fails records its outcome and asks the model nothing: reporting a
 * failure costs no new work (item 5).
 */

export const CHECK_LABEL = "Checked the map";

/** The words handed to the model beside the image: facts, no instruction. */
export function continuationText(render: { mapName: string; image: { width: number; height: number } }, facts: unknown): string {
  return `The map "${render.mapName}" as it now stands after your changes, rendered at ${render.image.width} by ${render.image.height} pixels. Facts: ${JSON.stringify(facts)}`;
}

/** Yields the check's events and the observation's; returns the observation reply, or null when no image reached the model. */
export async function* runAutomaticCheck(ctx: ActionContext, target: ScheduledCheck): AsyncGenerator<AssistantEvent, ProviderReply | null> {
  const tool = ctx.byName.get(LOOK_TOOL);
  if (!tool) return null;
  const id = `check:${randomUUID()}`;
  const args = { mapId: target.mapId, appearance: target.appearance };
  if (ctx.runId) assistantRuns.admit(ctx.runId, { id, name: LOOK_TOOL, args });
  yield { type: "tool_call", id, tool: LOOK_TOOL, args, effects: noEffects, label: CHECK_LABEL, automatic: true };
  const started = performance.now();
  let result;
  try {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    result = await executeTool(tool, args, ctx.baseUrl, ctx.fetchImpl, ctx.headers, ctx.signal);
  } catch {
    const body = { error: { code: "assistant_action_interrupted", message: "The read was interrupted before completion." } };
    yield { type: "tool_result", id, tool: LOOK_TOOL, ok: false, body, effects: noEffects, outcome: "refused", label: CHECK_LABEL, elapsedMs: Math.round(performance.now() - started), automatic: true };
    return null;
  }
  const look = shapeLookOutcome(LOOK_TOOL, result.ok, result.body);
  yield {
    type: "tool_result", id, tool: LOOK_TOOL, ok: result.ok, body: look.render ? look.eventBody : result.body, effects: noEffects,
    ...actionOutcome(result, noEffects), ...(look.outcome ? { outcome: look.outcome } : {}), label: CHECK_LABEL, elapsedMs: Math.round(performance.now() - started), automatic: true,
    ...(look.render ? { render: look.render } : {}),
  };
  if (!look.render || !look.image || !ctx.exchange.continueWithImage) return null;
  if (ctx.signal?.aborted) return null;
  const text = continuationText(look.render, look.eventBody);
  const image = look.image;
  const reply = yield* streamReply((options) => ctx.exchange.continueWithImage!({ text, image }, options), ctx.signal, ctx.runId);
  if (reply.text) yield { type: "message", text: reply.text, messageId: reply.messageId, ...(reply.model ? { model: reply.model } : {}) };
  // The observation reply ends the turn: its first sentence is the
  // observation, or the check completed with no text.
  const { displayed } = splitObservation(reply.text);
  yield displayed ? { type: "observation", id, state: "captured", text: displayed } : { type: "observation", id, state: "silent" };
  return reply;
}

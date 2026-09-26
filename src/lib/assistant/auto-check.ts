import type { Appearance } from "@/lib/export/image-definition";
import type { AssistantContext } from "./context";
import type { AssistantEvent } from "./loop";
import { LOOK_TOOL } from "./look-outcome";

/**
 * Automatic scheduling of the map check: pure rules over the turn's
 * facts. A check is scheduled once, at the end of a turn whose actions
 * changed the contextual map or its layers and settled as succeeded,
 * accepted or uncertain, when a map is in context, when no check of the
 * state after the last change has happened, and when spending the
 * check's step leaves its observation request admissible exhaustion
 * rule. The terminal reasons (cancellation, a provider error, an action
 * failure, exhaustion, a park) never reach the decision: the loop
 * consults it only where a turn ends normally.
 */

export interface TurnFacts {
  /** A qualifying change landed since the turn started or since the last successful check. */
  mutatedSince: boolean;
  /** The map the last qualifying change named, when it named one. */
  touchedMapId?: string;
  /** Checks the loop scheduled itself this turn. */
  automaticChecks: number;
  /** The checks whose observation the next text supplies (item
   * 4): every successful check of the batch, in order. */
  awaiting?: string[];
}

export const emptyTurnFacts = (): TurnFacts => ({ mutatedSince: false, automaticChecks: 0 });

type ResultEvent = Extract<AssistantEvent, { type: "tool_result" }>;

const SETTLED = new Set(["succeeded", "accepted", "uncertain"]);

/** A change that declared an effect on the contextual map or its layers
 * and settled. A layer write names its map through the history
 * association; one that names another map is not this map's, and one
 * that names none is counted, since the loop cannot say it was not. A
 * write that names specific maps, none of them the contextual one, is
 * another map's change whatever it declares broadly beside it (review
 * duplicating the contextual map names only its copy). */
export function qualifyingChange(event: ResultEvent, contextMapId?: string): boolean {
  if (!event.effects || event.effects.readOnly) return false;
  const outcome = event.outcome ?? (event.ok ? "succeeded" : "refused");
  if (!SETTLED.has(outcome)) return false;
  if (event.history && contextMapId !== undefined && event.history.mapId !== contextMapId) return false;
  const namedMaps = event.effects.writes.filter((write) => write.resource === "maps" && !write.collection);
  if (contextMapId !== undefined && namedMaps.length > 0 && !namedMaps.some((write) => write.ids.includes(contextMapId))) return false;
  return event.effects.writes.some((write) =>
    (write.resource === "maps" && (write.collection || contextMapId === undefined || write.ids.includes(contextMapId)))
    || write.resource === "layers");
}

/** Fold one event into the turn's facts. */
export function noteTurnEvent(facts: TurnFacts, event: AssistantEvent, context?: AssistantContext): TurnFacts {
  const contextMapId = context?.page === "builder" ? context.mapId : undefined;
  if (event.type === "observation") return { ...facts, awaiting: facts.awaiting?.filter((id) => id !== event.id) };
  if (event.type !== "tool_result") return facts;
  if (event.tool === LOOK_TOOL) {
    if (!event.ok) return facts;
    // A successful check of the contextual map's current state: nothing to
    // re-check until the next change; a look at another map settles
    // nothing here. Its observation is the next text's to supply.
    const ofThisMap = contextMapId === undefined || event.render?.mapId === contextMapId;
    return { ...facts, ...(ofThisMap ? { mutatedSince: false } : {}), automaticChecks: facts.automaticChecks + (event.automatic ? 1 : 0), awaiting: [...(facts.awaiting ?? []), event.id] };
  }
  if (!qualifyingChange(event, contextMapId)) return facts;
  const named = event.history?.mapId ?? event.effects?.writes.find((w) => w.resource === "maps" && w.ids.length > 0)?.ids[0];
  return { ...facts, mutatedSince: true, ...(named ? { touchedMapId: named } : {}) };
}

export interface ScheduledCheck { mapId: string; appearance: Appearance }

/** Whether to schedule a check now, at a turn's normal end. */
export function decideAutomaticCheck(input: { context?: AssistantContext; facts: TurnFacts; steps: number; budget: number; enabled: boolean }): ScheduledCheck | null {
  if (!input.enabled) return null;
  // Only a contextual map: an explicit-map check is the model's to ask for.
  if (input.context?.page !== "builder") return null;
  // A qualifying change since the last successful check; once per turn.
  if (!input.facts.mutatedSince || input.facts.automaticChecks > 0) return null;
  // The exhaustion rule: the check spends a step, and the observation
  // request after it must still be admissible.
  if (input.steps + 1 >= input.budget) return null;
  return { mapId: input.context.mapId, appearance: input.context.appearance ?? "light" };
}

/** A model-requested check that names no map is aimed at the contextual
 * one, with the context's appearance when it names none; a headless
 * call without either is the documented outcome. */
export function withContextualMap(args: Record<string, unknown>, context?: AssistantContext): Record<string, unknown> {
  if (context?.page !== "builder") return args;
  return {
    ...args,
    ...(args.mapId === undefined || args.mapId === null || args.mapId === "" ? { mapId: context.mapId } : {}),
    ...(args.appearance === undefined && context.appearance ? { appearance: context.appearance } : {}),
  };
}

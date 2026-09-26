import { PROVIDER_DEFAULT_EFFORT, type EffortChoice, type ModelKnowledge } from "@/lib/assistant/model-knowledge";

/**
 * What the pane shows for a model and effort choice. Pure shaping, apart
 * from the control that renders it and the store that remembers it: what the
 * chip reads, whether the control stands at all, and what a pick resolves
 * to.
 *
 * The effort words are the selected model's own: there is no shared
 * scale, so nothing here translates one provider's word into another's. The
 * provider-default entry is a real selectable value meaning "send no
 * setting", and the chip shows no effort word for it, because no effort word
 * would be true of the request that goes out.
 */

export type ModelChoice = { model: string; effort: string };

/** The control stands where the instance offers something to choose. A
 * single-model instance is exactly what ships today, the quiet model line
 * included (page 04's "One model only"). */
export function pickerShown(models: ModelKnowledge[]): boolean {
  return models.length > 1;
}

/** The instance's own answer, as the status read reports it. */
export function defaultChoice(instanceModel: string): ModelChoice {
  return { model: instanceModel, effort: PROVIDER_DEFAULT_EFFORT };
}

export function modelIn(models: ModelKnowledge[], id: string): ModelKnowledge | undefined {
  return models.find((model) => model.id === id);
}

/** The chip's words: the model's display name, and the model's own word for
 * the chosen level where a level is actually chosen. */
export function chipWords(models: ModelKnowledge[], choice: ModelChoice): { name: string; effort?: string } {
  const model = modelIn(models, choice.model);
  const name = model?.name ?? choice.model;
  if (!model || choice.effort === PROVIDER_DEFAULT_EFFORT) return { name };
  const effort = model.efforts.find((level) => level.value === choice.effort);
  return effort ? { name, effort: effort.label } : { name };
}

/** Picking a model carries the level over where the new model offers it,
 * and otherwise returns to that model's provider default: a level is one
 * model's own word and means nothing on another. */
export function chooseModel(models: ModelKnowledge[], choice: ModelChoice, id: string): ModelChoice {
  const model = modelIn(models, id);
  const keeps = model?.efforts.some((level) => level.value === choice.effort) ?? false;
  return { model: id, effort: keeps ? choice.effort : PROVIDER_DEFAULT_EFFORT };
}

/** The levels the menu offers a row for: the model's own words, and none
 * at all where the provider-default entry is the whole list. A single
 * choice that changes nothing is not a choice, so the row is revealed by
 * its context rather than standing empty (the contextual-reveal habit).
 * The keyboard walk reads the same list, so what is shown and what is
 * reachable cannot drift apart. */
export function menuEfforts(models: ModelKnowledge[], id: string): EffortChoice[] {
  const efforts = modelIn(models, id)?.efforts ?? [];
  return efforts.length > 1 ? efforts : [];
}

/**
 * What a message request carries for the choice. Where nobody has picked,
 * the request is byte-for-byte the one this pane sent before the picker
 * existed, so an untouched instance cannot be changed by the control's
 * mere presence; where a pick was made it travels whole, the
 * provider-default entry included, so the record can say the person asked
 * for it rather than the instance supplying it.
 *
 * Whole for every model, including one that offers no levels of its own:
 * the route accepts the provider-default entry for every model it offers
 * and it resolves there to exactly the
 * request the model alone would make. The pane therefore needs no rule of
 * its own about which half may travel, which is the simpler half to hold:
 * what it remembers is what it sends.
 */
export function choicePayload(remembered: ModelChoice | null): { choice?: ModelChoice } {
  return remembered ? { choice: remembered } : {};
}

/**
 * The pair a submission binds its run to: the person's pick where there is
 * one, and otherwise the instance's own default, which is what the request
 * will in fact be answered by. It is not the same question as
 * `choicePayload`'s: what travels and what the pane displays differ
 * exactly here, and collapsing them would either send a setting nobody
 * chose or show a run bound to nothing. Where the status read has not
 * arrived, an untouched pane binds nothing rather than guessing an
 * identity.
 */
export function boundFor(remembered: ModelChoice | null, instanceModel: string | undefined): ModelChoice | undefined {
  if (remembered) return remembered;
  return instanceModel ? defaultChoice(instanceModel) : undefined;
}

/**
 * A remembered pair read against the status actually read. A status read
 * is a snapshot: the instance may be reconfigured between one message and
 * the next, and the pane must not go on displaying, or sending, a pair
 * that is no longer on offer.
 *
 * The fallback is per half, and it is the reported default for the half
 * that went: a model the read does not list takes the whole pair back to
 * the instance's own default, because a level is only ever a level of some
 * model; a model that stands with a level it no longer offers keeps the
 * model and takes the level back to the provider-default entry, since
 * discarding a choice the instance can still honour would lose more than
 * the read did. Returned by identity when nothing has to move, so a
 * render cannot mistake a reconciliation for a change.
 *
 * Where there is nothing to choose there is nothing to reconcile, and the
 * pane holds no pair at all: a single-model
 * instance, an instance older than the picker, and a status this pane has
 * not read all leave the person with no control to see a pair on and none
 * to reset it with, so a pair the tab still remembers neither shows nor
 * travels. Nothing is thrown away — it is taken up again where a picker
 * stands to show it.
 */
export function reconcile(models: ModelKnowledge[], remembered: ModelChoice | null, instanceModel: string | undefined): ModelChoice | null {
  if (!remembered) return null;
  if (!pickerShown(models) || !instanceModel) return null;
  const model = modelIn(models, remembered.model);
  if (!model) return defaultChoice(instanceModel);
  if (model.efforts.some((level) => level.value === remembered.effort)) return remembered;
  return { model: remembered.model, effort: PROVIDER_DEFAULT_EFFORT };
}

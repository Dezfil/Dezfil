/** Client-safe vocabulary and presentation; server reads supply a fresh catalogue. */
export type CatalogueEntry = { id: string; name: string; efforts: string[] };
export type ModelCatalogue = { openai: CatalogueEntry[]; anthropic: CatalogueEntry[] };

/** The explicit entry meaning "whatever the model does with no setting".
 * Not a word either provider uses, so it can never collide with a level. */
export const PROVIDER_DEFAULT_EFFORT = "default";

export type EffortChoice = {
  /** The provider's own word, as it travels on the request. */
  value: string;
  /** What the pane shows for it. */
  label: string;
};

export type ModelKnowledge = {
  id: string;
  /** The display name, or the identity itself when Dezfil has none. */
  name: string;
  /** The provider-default entry first, then the model's own levels in the
   * provider's order. Never empty: the entry alone for a model Dezfil
   * knows no levels for, since a request may always name it. */
  efforts: EffortChoice[];
};

const LABELS: Record<string, string> = {
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const choice = (value: string): EffortChoice => ({ value, label: LABELS[value] ?? value });

/**
 * What to show and what to offer for one identity under one provider. An
 * unknown identity, or one under a provider this instance cannot resolve,
 * reads as itself and offers the provider default alone — never an error,
 * since listing an identity is the owner's prerogative, and never an empty
 * list, which would say the no-choice request is unanswerable for it.
 */
export function describeModel(provider: string, id: string, catalogue: ModelCatalogue): ModelKnowledge {
  const known = (catalogue[provider as keyof ModelCatalogue] ?? []).find((model) => model.id === id);
  if (!known) return { id, name: id, efforts: [choice(PROVIDER_DEFAULT_EFFORT)] };
  return {
    id,
    name: known.name,
    efforts: [choice(PROVIDER_DEFAULT_EFFORT), ...known.efforts.map(choice)],
  };
}

/**
 * What a chosen level means on the wire: `null` when nothing is to be sent
 * — no choice, an empty one, or the explicit provider-default entry, all of
 * which preserve the model's own no-setting behavior. Otherwise the
 * provider's own word, which each adapter puts in its own request field.
 */
export function effortToSend(effort?: string | null): string | null {
  const chosen = effort?.trim();
  if (!chosen || chosen === PROVIDER_DEFAULT_EFFORT) return null;
  return chosen;
}

import type { AssistantPage } from "@/lib/api/operation-metadata";
import { buildTools, type ToolDef } from "@/lib/tools/tools";
import { admittedTools, type AssistantPolicy } from "./policy";

/**
 * The default offer: what a run's model is shown at its start, derived
 * from the operations' declared page relevance inside what the page's
 * policy admits. Admission is the policy's alone: the offer is a
 * filter of the admitted set and can never widen it, a call outside the
 * offer but inside admission still runs, and a call outside admission is
 * refused however it arrived. Discovery (discovery.ts) reaches what the
 * offer omitted. A run with no page context keeps the full admitted
 * offer.
 *
 * The mode is the measured decision of spec item 7: `subset` narrows to
 * the page's operations and the grounding reads; `full` keeps every
 * admitted operation, under which nothing is omitted and discovery is
 * not offered.
 */
export type OfferMode = "subset" | "full";

/** The mode an instance runs unless it is configured otherwise: each
 * page is offered its own subset. The full admitted set is the
 * alternative, selected by configuration. */
export const MEASURED_OFFER_MODE: OfferMode = "subset";

/** The mode this instance runs: DEZFIL_ASSISTANT_OFFER selects `subset`
 * or `full`; anything else is the measured default. Read at each call so
 * the policy read and the message route answer the same setting. */
export function defaultOfferMode(env: Record<string, string | undefined> = process.env): OfferMode {
  const raw = env.DEZFIL_ASSISTANT_OFFER;
  return raw === "subset" || raw === "full" ? raw : MEASURED_OFFER_MODE;
}

/** The reads the grounding block points the model at, offered on every
 * page whatever its relevance: the table catalogue and the reads of the
 * map, the layer, the workflow, its step and its run. */
export const GROUNDING_READS: readonly string[] = [
  "read_table_catalogue", "list_tables", "get_map", "get_layer", "list_layers", "get_recipe", "get_recipe_step", "get_recipe_run",
];

export function defaultOffer(page: AssistantPage | undefined, policy: AssistantPolicy, tools: ToolDef[] = buildTools(), mode: OfferMode = defaultOfferMode()): ToolDef[] {
  const admitted = admittedTools(policy, tools);
  if (!page || mode === "full") return admitted;
  return admitted.filter((tool) => tool.relevance.includes(page) || GROUNDING_READS.includes(tool.name));
}

/** The admitted operations the offer omitted: what discovery can reach. */
export function omittedFromOffer(page: AssistantPage | undefined, policy: AssistantPolicy, tools: ToolDef[] = buildTools(), mode: OfferMode = defaultOfferMode()): ToolDef[] {
  const offered = new Set(defaultOffer(page, policy, tools, mode).map((tool) => tool.name));
  return admittedTools(policy, tools).filter((tool) => !offered.has(tool.name));
}

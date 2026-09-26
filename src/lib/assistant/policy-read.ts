import type { AssistantPage } from "@/lib/api/operation-metadata";
import { buildTools } from "@/lib/tools/tools";
import { DISCOVERY_TOOL } from "./discovery";
import { defaultOffer, defaultOfferMode, type OfferMode } from "./offer";
import { admittedTools, policyFor, type AssistantPolicy } from "./policy";

/**
 * The policy read's answer: for a page, the policy its runs bind with,
 * every operation it admits, the operations its runs are offered at the
 * start, and whether discovery is offered to reach the rest. Derived
 * from the same modules the message route uses, so the answer equals
 * what a run under that page is shown; `offer` names the mode the
 * instance runs (the measured default, or DEZFIL_ASSISTANT_OFFER).
 */
export interface AssistantPolicyRead {
  page: AssistantPage;
  policy: AssistantPolicy;
  offer: OfferMode;
  admitted: string[];
  offered: string[];
  discovery: boolean;
}

export function assistantPolicyRead(page: AssistantPage, mode: OfferMode = defaultOfferMode()): AssistantPolicyRead {
  const policy = policyFor({ page } as never);
  const tools = buildTools();
  const admitted = admittedTools(policy, tools).map((tool) => tool.name).sort();
  const offered = defaultOffer(page, policy, tools, mode).map((tool) => tool.name).sort();
  const discovery = offered.length < admitted.length;
  return { page, policy, offer: mode, admitted, offered: discovery ? [...offered, DISCOVERY_TOOL].sort() : offered, discovery };
}

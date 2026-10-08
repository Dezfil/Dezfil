import type { AssistantContext } from "./context";
import { buildTools, type ToolDef } from "@/lib/tools/tools";

/**
 * The page action policy, derived from the submitted context's page and
 * nothing else. A run under the builder, or with no context, keeps
 * today's whole tool set with its confirmation gates; a run under /sql or
 * the workflow canvas is offered only the operations that declare
 * themselves read-only (effects), and a conditional operation, one that
 * plans in one form and writes in another, is offered in neither form
 * (D4), nor is a read-only operation marked as reaching outside this
 * server (a service's Test), which sends a request a page that only reads
 * did not ask for. The model is never told to avoid an operation: it is
 * offered what its run admits, and a call outside the set, however it arrives, is
 * refused before any product operation (the phase rule: the API refuses
 * where a page would warn).
 *
 * The policy binds at the run's first accepted submission and travels
 * with its parked state through confirmation continuations.
 */
export type AssistantPolicy = "full" | "read_only";

export const POLICY_REFUSAL_CODE = "assistant_action_not_admitted" as const;

export function policyFor(context: AssistantContext | undefined): AssistantPolicy {
  return context?.page === "sql" || context?.page === "workflow" ? "read_only" : "full";
}

/** Whether one operation is inside a policy's set. */
export function admits(policy: AssistantPolicy, tool: Pick<ToolDef, "effects">): boolean {
  if (policy === "full") return true;
  return tool.effects.readOnly && tool.effects.planningArgument === undefined && !tool.effects.reachesOutside;
}

/** The tools a run under this policy is offered. */
export function admittedTools(policy: AssistantPolicy, tools: ToolDef[] = buildTools()): ToolDef[] {
  return policy === "full" ? tools : tools.filter((tool) => admits(policy, tool));
}

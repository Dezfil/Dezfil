import type { AssistantContext } from "@/lib/assistant/context";
import type { PageFacts } from "../builder/assistant/talking-about";
import type { CanvasMember } from "./graph";
import type { WorkflowRun } from "./run-overlay";

/**
 * The workflow canvas's assistant context (workflow): the open recipe,
 * the selected step or none (a selected source or note supplies no
 * step), and the last observed run or none, the run the page most
 * recently saw start or settle. Pure; the same identities word the
 * pane's chips.
 */
export type WorkflowAssistantContext = Extract<AssistantContext, { page: "workflow" }>;
export type WorkflowPageFacts = Extract<PageFacts, { page: "workflow" }>;

/** The selected recipe step, if the selection is a node. */
export function selectedStep(member: CanvasMember | null): { id: string; label: string } | null {
  return member && member.kind === "node" ? { id: member.step.id, label: member.label } : null;
}

/** The run the page most recently saw start or settle: the one in flight
 * or whose outcome is still shown, else the last to end. */
export function lastObservedRun(runner: { active: WorkflowRun | null; ended: WorkflowRun | null }): WorkflowRun | null {
  return runner.active ?? runner.ended ?? null;
}

export function workflowAssistantContext(recipeId: string, member: CanvasMember | null, run: WorkflowRun | null): WorkflowAssistantContext {
  return { page: "workflow", recipeId, selectedStepId: selectedStep(member)?.id ?? null, lastRunId: run?.id ?? null };
}

export function workflowFacts(workflowName: string, member: CanvasMember | null, run: WorkflowRun | null): WorkflowPageFacts {
  const fact = run === null ? null
    : run.outcome === null ? { kind: "running" as const, startedAt: run.startedAt }
    : { kind: "settled" as const, outcome: run.outcome, finishedAt: run.finishedAt ?? run.startedAt };
  return { page: "workflow", workflowName, selectedStepLabel: selectedStep(member)?.label ?? null, run: fact };
}

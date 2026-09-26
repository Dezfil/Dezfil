import type { OperationJob } from "@/lib/metadata/jobs";
import type { RecipeStep } from "@/lib/metadata/recipes";
import type { StepCondition } from "./step-condition";
import { dependenciesWithin } from "./recipe-order";

/**
 * A workflow's one-line state.
 *
 * **Computed here, reported by the API, rendered by the page** — the chip a
 * card wears is product semantics, not decoration, so an agent and the
 * gallery read the same classification. The precedence is the spec's, and a
 * node in more than one condition counts once, in the state the workflow
 * shows. A cancelled attempt alone puts nothing in need of attention.
 */
export type WorkflowStatus =
  | "empty"
  | "cannot_run"
  | "in_progress"
  | "failed"
  | "run_again"
  | "never_run"
  | "partly_never_run"
  | "up_to_date";

export interface RecipeSummary {
  /** Nodes in the workflow. */
  nodes: number;
  /** Distinct tables read that no node of this workflow produces. */
  sources: number;
  /** Outputs whose dataset currently exists — what a deletion leaves behind. */
  liveOutputs: number;
  status: WorkflowStatus;
  /** How many nodes the status counts; 0 for *empty* and *up to date*. */
  count: number;
}

export interface SummaryInput {
  step: RecipeStep;
  condition: StepCondition;
  latestAttempt: OperationJob | null;
  reads: string[];
}

export function summarizeRecipe(
  views: SummaryInput[],
  /** The artifact each registered table currently holds, by table id. */
  artifactOf: Map<string, string>,
): RecipeSummary {
  const steps = views.map((v) => v.step);
  const external = new Set<string>();
  for (const v of views) {
    for (const name of v.reads) {
      if (dependenciesWithin(steps, [name]).length === 0) external.add(name);
    }
  }
  const liveOutputs = steps.filter(
    (s) => s.outputTableId !== null && artifactOf.has(s.outputTableId),
  ).length;
  const base = { nodes: steps.length, sources: external.size, liveOutputs };
  if (steps.length === 0) return { ...base, status: "empty", count: 0 };

  const state = (v: SummaryInput) => v.latestAttempt?.state ?? null;
  const cannotRun = views.filter((v) => v.condition.conditions.includes("broken"));
  if (cannotRun.length) return { ...base, status: "cannot_run", count: cannotRun.length };
  const inProgress = views.filter((v) => state(v) === "queued" || state(v) === "running");
  if (inProgress.length) return { ...base, status: "in_progress", count: inProgress.length };
  const failed = views.filter((v) => state(v) === "failed");
  if (failed.length) return { ...base, status: "failed", count: failed.length };
  const runAgain = views.filter(
    (v) =>
      v.condition.conditions.includes("output_missing") ||
      v.condition.conditions.includes("stale") ||
      v.step.proposedParameters !== null,
  );
  if (runAgain.length) return { ...base, status: "run_again", count: runAgain.length };
  const neverRun = steps.filter((s) => s.outputTableId === null);
  if (neverRun.length === steps.length) return { ...base, status: "never_run", count: neverRun.length };
  if (neverRun.length) return { ...base, status: "partly_never_run", count: neverRun.length };
  return { ...base, status: "up_to_date", count: 0 };
}

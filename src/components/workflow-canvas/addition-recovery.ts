import type { WorkflowListing, WorkflowStep } from "../workflow-model";
import type { LayoutRead } from "./placement";
import type { AddInput } from "./use-recipe-edits";
import type { WorkflowDocument } from "./workflow-document";
import { fetchLayout, fetchWorkflow } from "./workflow-read";

const facts = ["editRevision", "lastChangedAt", "lastChangedBy", "updatedAt"];
const without = (value: object, ignored: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.includes(key)));
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const definition = (step: WorkflowStep) => without(step, [...facts, "summary", "output", "condition", "conditions", "causes", "missingInputs", "inputs", "reads", "latestAttempt", "lastSuccessAt"]);
const recipeContents = (recipe: WorkflowListing) => ({
  ...without(recipe, [...facts, "summary"]), steps: recipe.steps.map(definition),
});
const layoutContents = (layout: LayoutRead, recipe: WorkflowListing) => ({
  ...without(layout, facts),
  // Reads prune positions of deleted nodes; a preceding accepted removal
  // can still leave such a position in the client's saved layout snapshot.
  steps: Object.fromEntries(Object.entries(layout.steps).filter(([id]) => recipe.steps.some(step => step.id === id))),
});

/** Capture the exact pre-send document, then reconcile only this addition.
 * A history preflight read cannot establish a new basis for an old inverse.
 * A lost write's complete result can, before its ordered turn is released. */
export function additionRecovery(document: WorkflowDocument, input: AddInput): () => Promise<WorkflowStep | null> {
  const { recipe: before, layout, revision } = document;
  return async () => {
    // Cross-workflow copies can translate SQL, so their result cannot be
    // proven by comparing the submitted parameters in this workflow.
    if (!before || !layout || !revision || input.writtenIn || document.stale || document.disposed) return null;
    try {
      const [read, positions] = await Promise.all([fetchWorkflow(document.id), fetchLayout(document.id)]);
      if (document.stale || document.disposed || document.revision !== revision) return null;
      if (!read.editRevision || read.editRevision === revision || read.editRevision !== positions.editRevision) return null;
      const added = read.steps.filter(step => !before.steps.some(prior => prior.id === step.id));
      if (added.length !== 1) return null;
      const step = added[0];
      const origin = (step as WorkflowStep & { origin?: unknown }).origin;
      if (read.steps.at(-1) !== step || step.ordinal !== before.steps.length || step.operation !== input.operation ||
          stable(step.parameters) !== stable(input.parameters) || step.proposedParameters != null ||
          origin != null || step.output != null || step.lastSuccessAt != null) return null;
      const remainder = { ...read, steps: read.steps.filter(candidate => candidate.id !== step.id) };
      if (stable(recipeContents(before)) !== stable(recipeContents(remainder)) ||
          stable(layoutContents(layout, before)) !== stable(layoutContents(positions, read))) return null;
      document.install(read, positions);
      return step;
    } catch { /* An unreadable or divergent outcome leaves the old basis intact. */ }
    return null;
  };
}

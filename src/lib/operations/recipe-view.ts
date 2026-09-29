import type { DatasetScope } from "@/lib/query/access";
import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { listJobs, type OperationJob } from "@/lib/metadata/owned-jobs";
import { edgesForStep, type LineageEdge } from "@/lib/metadata/lineage";
import {
  requireRecipe,
  requireStep,
  listSteps,
  type Recipe,
  type RecipeStep,
} from "@/lib/metadata/owned-recipes";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import {
  deriveConditions,
  type ConditionEdge,
  type StepCondition,
} from "./step-condition";
import { stepReads } from "./step-reads";
import { dependenciesWithin } from "./recipe-order";
import { summarizeRecipe, type RecipeSummary } from "./recipe-summary";

/**
 * Reading a recipe.
 *
 * **A condition and a job are read together, and neither replaces the other.**
 * A step reports every condition true of it — broken, output missing, stale,
 * never run, current — *and* its latest attempt, which is an ordinary job in
 * one of five states. *Fresh output, latest attempt failed* is a real and
 * common combination, so a view that collapsed the two could not express the
 * situation a user is most likely to be looking at.
 *
 * **One registry snapshot answers the whole recipe.** Conditions are
 * relational — broken travels downstream, staleness is recursive — so reading
 * the tables once and deriving everything from that one map is not an
 * optimisation: two reads could straddle a refresh and produce a report in
 * which a step is stale because of a table another step saw as current.
 */

export interface StepView {
  step: RecipeStep;
  condition: StepCondition;
  /** The step's most recent run, whatever became of it; null if it never ran. */
  latestAttempt: OperationJob | null;
  /** What this step read the last time it published. */
  edges: LineageEdge[];
  /** What this step would read on its next run: the
   * pending definition's reads when it holds one, the active definition's
   * otherwise — before any run, and whether or not the tables exist. Kept
   * apart from `edges`, which is the recorded past. */
  reads: string[];
}

export interface RecipeView {
  recipe: Recipe;
  steps: StepView[];
  /** The workflow's one-line state and counts. */
  summary: RecipeSummary;
}

/** The artifact each registered table currently holds. A table absent from
 * this map has been deleted, which is what makes a step *broken* rather than
 * merely out of date. */
export function currentArtifacts(scope: AccountScope): Map<string, string> {
  return new Map(listOwnedTables(scope).map((t) => [t.id, t.file]));
}

/**
 * Missing inputs a step would read on its next run, as prospective edges.
 *
 * **Lineage records only what last succeeded**, so it cannot describe a never-
 * published definition or a published step's pending definition. Without these
 * edges, either can name a missing table while being offered a run that cannot
 * succeed. Prospective edges carry no bound artifact, so they can make a step
 * broken and can never make one stale: nothing was ever bound to be behind.
 */
function prospectiveEdges(
  scope: AccountScope,
  steps: RecipeStep[],
  readsByStepId: Map<string, string[]>,
  recordedByStepId: Map<string, { inputTableName: string }[]>,
): ConditionEdge[] {
  const byName = new Map(listOwnedTables(scope).map((t) => [t.name.toLowerCase(), t]));
  const reads = steps.map((step) => {
    const names = readsByStepId.get(step.id) ?? [];
    const earlier = steps.filter((candidate) => candidate.ordinal < step.ordinal);
    const recorded = new Set(
      (recordedByStepId.get(step.id) ?? []).map((edge) =>
        edge.inputTableName.toLowerCase(),
      ),
    );
    return names
      // A name no table carries is what makes the step broken; a name that
      // *does* resolve is an ordinary input and needs no prospective edge.
      .filter((name) => !byName.has(name.toLowerCase()))
      // A loss the recorded lineage already names must not be named twice:
      // the recorded edge survives deletion by design and alone carries
      // the broken evidence.
      .filter((name) => !recorded.has(name.toLowerCase()))
      // And a name an earlier step in this recipe will *produce* is a
      // dependency, not a missing input. Without this, the second step of
      // every freshly authored recipe would read as broken before anything
      // had been run — which is the ordinary case, not a failure.
      .filter((name) => dependenciesWithin(earlier, [name]).length === 0)
      .map((name) => ({
        id: `prospective:${step.id}:${name}`,
        prospective: true as const,
        stepId: step.id,
        outputTableId: "",
        // No id exists for a table that is not there. The empty id is absent
        // from the artifact map by construction, which is exactly what
        // "broken" is derived from.
        inputTableId: `missing:${name}`,
        inputTableName: name,
        boundArtifact: "",
        recordedAt: step.updatedAt,
      }));
  });
  return reads.flat();
}

/** Every step's present reads, once per read of the recipe. A definition the
 * parser cannot read (a SQL node mid-edit) reads nothing rather than failing
 * the whole recipe's view. */
async function presentReads(scope: DatasetScope, steps: RecipeStep[]): Promise<Map<string, string[]>> {
  const entries = await Promise.all(
    steps.map(
      async (s) => [s.id, await stepReads(scope, s).catch(() => [] as string[])] as const,
    ),
  );
  return new Map(entries);
}

export async function readRecipe(scope: AccountScope, recipeId: string): Promise<RecipeView> {
  const recipe = requireRecipe(scope, recipeId);
  const steps = listSteps(scope, recipeId);
  const reads = await presentReads(scope, steps);
  const edgesByStep = new Map(steps.map((s) => [s.id, edgesForStep(scope, s.id)]));
  for (const edge of prospectiveEdges(scope, steps, reads, edgesByStep)) {
    edgesByStep.get(edge.stepId)?.push(edge);
  }
  const artifacts = currentArtifacts(scope);
  const conditions = deriveConditions({
    steps,
    edges: [...edgesByStep.values()].flat(),
    currentArtifact: artifacts,
  });

  const views: StepView[] = steps.map((step) => ({
    step,
    condition: conditions.get(step.id)!,
    latestAttempt:
      listJobs(scope, { subjectId: step.id, subjectKind: "step", limit: 1 })[0] ?? null,
    edges: edgesByStep.get(step.id) ?? [],
    reads: reads.get(step.id) ?? [],
  }));
  requireOwnedResource(scope, "workflow", recipeId);
  return { recipe, steps: views, summary: summarizeRecipe(views, artifacts) };
}

/** One step's view, for the surfaces that address a step directly. */
export async function readStep(
  scope: AccountScope,
  recipeId: string,
  stepId: string,
): Promise<StepView> {
  requireStep(scope, recipeId, stepId);
  const found = (await readRecipe(scope, recipeId)).steps.find(
    (s) => s.step.id === stepId,
  );
  return found!;
}

import { accountLabels } from "@/lib/metadata/accounts";
import { documentFacts, type DocumentFacts } from "@/lib/metadata/document-facts";
import type { DatasetScope } from "@/lib/query/access";
import type { AccountScope } from "@/lib/auth/scope";
import { canReach } from "@/lib/auth/reach";
import { latestStepAttempt, type OperationJob } from "@/lib/metadata/owned-jobs";
import { reachedEdgesForStep, type LineageEdge } from "@/lib/metadata/lineage";
import {
  requireRecipe,
  requireStep,
  listSteps,
  recipeStanding,
  type Recipe,
  type RecipeStep,
} from "@/lib/metadata/owned-recipes";
import { resolveReference, unavailableDataset, type Namespace } from "@/lib/query/bindings";
import { workflowEvaluation } from "@/lib/query/context";
import { namespaceFor } from "@/lib/query/namespace";
import { presencesOf, type Presence } from "@/lib/reach-presence";
import { metadataDb } from "@/lib/metadata/db";
import { runnerOutput } from "@/lib/metadata/recipe-outputs";
import {
  deriveConditions,
  type ConditionEdge,
  type StepCondition,
} from "./step-condition";
import { stepReads } from "./step-reads";
import { dependenciesWithin } from "./recipe-order";
import { summarizeRecipe, type RecipeSummary } from "./recipe-summary";
import { linkFilter, type OutputLink } from "./output-links";

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
 *
 * **Everything is read in the workflow's home within the reader's reach.**
 * A workflow is read by everyone who reaches it, and its view is resolved
 * where its names belong: a plain name means the home account's dataset or
 * the workflow's own declared output, as the reader would run it, and the
 * world the conditions are derived from is the set of datasets the reader
 * reaches. The reader's own space never stands in for the home. A reference
 * the reader cannot reach reads as missing, named as written, with the same
 * sentence a resource evaluation gives; recorded lineage, output links and a
 * captured layer's identity that the reader cannot reach are left out, never
 * named.
 */

/** Whose run a step's output, lineage and conditions describe, and which
 * run: the reader's own latest output of the step when they have one, else
 * the workflow owner's; null when neither has produced one. */
export interface DescribedRun {
  runner: { name: string; sqlName: string };
  runId: string | null;
  jobId: string | null;
}

export interface StepView {
  /** The step, its output and last success those of the described run. */
  step: RecipeStep;
  described?: DescribedRun | null;
  /** The described run's output as the reader may follow it, naming its
   * runner and run; null when there is none to show. */
  output?: (OutputLink & DescribedRun) | null;
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
  facts: DocumentFacts;
  recipe: Recipe;
  steps: StepView[];
  /** The workflow's one-line state and counts. */
  summary: RecipeSummary;
  /** The project it is filed in as its reader reaches it, its owner and its
   * SQL home. */
  presence: Presence;
  context: ReaderContext;
}

/** What a payload asks of its reader's reach. */
export interface ReaderContext {
  /** Which output links the reader may follow. */
  link: (link: OutputLink | null) => OutputLink | null;
  /** Whether the reader reaches the map a step was captured from. */
  reachesMap: (mapId: string) => boolean;
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
  namespace: Namespace,
  steps: RecipeStep[],
  readsByStepId: Map<string, string[]>,
  recordedByStepId: Map<string, { inputTableName: string }[]>,
): ConditionEdge[] {
  const reads = steps.map((step) => {
    const names = readsByStepId.get(step.id) ?? [];
    const earlier = steps.filter((candidate) => candidate.ordinal < step.ordinal);
    const recorded = new Set(
      (recordedByStepId.get(step.id) ?? []).map((edge) =>
        edge.inputTableName.toLowerCase(),
      ),
    );
    return names
      // A name that binds no dataset in the reader's reach is what makes the
      // step broken; a name that *does* bind is an ordinary input and needs no
      // prospective edge.
      .filter((name) => resolveReference(namespace, [name]).status !== "bound")
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

/**
 * Each step as one runner's: the reader's own recorded output when they have
 * one, else the workflow owner's. A workflow's output has one identity per
 * runner, so a view that mixed one person's output with another's lineage
 * would describe no run at all.
 */
function describedSteps(scope: AccountScope, steps: RecipeStep[], ownerId: string): { steps: RecipeStep[]; runs: Map<string, { accountId: string; run: DescribedRun } | null> } {
  const runs = new Map<string, { accountId: string; run: DescribedRun } | null>();
  const labels = accountLabels([scope.accountId, ownerId]);
  const described = steps.map((step) => {
    const own = runnerOutput(step.id, scope.accountId);
    const output = own ?? runnerOutput(step.id, ownerId);
    const accountId = own ? scope.accountId : ownerId;
    const person = output ? labels.get(accountId) : undefined;
    runs.set(step.id, output && person ? { accountId, run: { runner: person, runId: output.runId, jobId: output.jobId } } : null);
    return {
      ...step,
      outputTableId: output?.id ?? null,
      outputTableName: output?.name ?? null,
      lastSuccessAt: output?.succeededAt ?? null,
    };
  });
  return { steps: described, runs };
}

/** The described outputs that still exist but lie outside the reader's
 * reach: the workflow owner's, shown to a reader with none of their own. */
function outputsOutOfReach(steps: RecipeStep[], artifacts: ReadonlyMap<string, string>): Set<string> {
  const exists = metadataDb().prepare("SELECT 1 FROM data_tables WHERE id = ?");
  return new Set(steps.flatMap((step) =>
    step.outputTableId && !artifacts.has(step.outputTableId) && exists.get(step.outputTableId) ? [step.outputTableId] : []));
}

function describedOutput(scope: AccountScope, step: RecipeStep, described: { accountId: string; run: DescribedRun } | null,
  ownerId: string): (OutputLink & DescribedRun) | null {
  if (!step.outputTableId || !described) return null;
  const link = linkFilter(scope, [ownerId, described.accountId])({ id: step.outputTableId, name: step.outputTableName ?? "" });
  return link ? { ...link, ...described.run } : null;
}

export async function readRecipe(scope: AccountScope, recipeId: string): Promise<RecipeView> {
  const { recipe, standing, steps, runs, facts, evaluation, namespace, edgesByStep, attempts } = metadataDb().transaction(() => {
    const recipe = requireRecipe(scope, recipeId), standing = recipeStanding(recipeId)!;
    const { steps, runs } = describedSteps(scope, listSteps(scope, recipeId), standing.ownerId);
    const evaluation = workflowEvaluation(scope, recipeId);
    const namespace = namespaceFor(evaluation);
    const reachable = new Set(namespace.datasets.map((dataset) => dataset.id));
    // Child reach checks belong to the captured definition. A node can be
    // removed while SQL presentation awaits; that does not remove its workflow.
    const edgesByStep = new Map<string, ConditionEdge[]>(steps.map((step) =>
      [step.id, reachedEdgesForStep(scope, step.id, reachable, undefined, runs.get(step.id)?.accountId ?? null)]));
    const attempts = new Map(steps.map((step) => [step.id, latestStepAttempt(scope, step.id)]));
    return { recipe, standing, steps, runs, evaluation, namespace, edgesByStep, attempts,
      facts: documentFacts({ kind: "workflow", id: recipeId }) };
  })();
  // A reader whose own space is the workflow's home reads its names as their
  // own; anyone else reads every name in someone else's space.
  const home = namespace.home.id === scope.accountId;
  const reads = await presentReads(evaluation, steps);
  for (const edge of prospectiveEdges(namespace, steps, reads, edgesByStep)) {
    edgesByStep.get(edge.stepId)?.push(edge);
  }
  const artifacts = new Map(namespace.datasets.map((dataset) => [dataset.id, dataset.file]));
  const conditions = deriveConditions({
    steps,
    edges: [...edgesByStep.values()].flat(),
    currentArtifact: artifacts,
    unavailable: outputsOutOfReach(steps, artifacts),
  });
  if (!home) {
    for (const condition of conditions.values()) {
      condition.missingInputs = condition.missingInputs.map((missing) => missing.throughStepId
        ? missing
        : { ...missing, message: unavailableDataset(missing.tableName).message });
    }
  }

  const views: StepView[] = steps.map((step) => ({
    step,
    described: runs.get(step.id)?.run ?? null,
    // The described run's output, followed by whoever reaches it; a gone one
    // is told to whoever recorded it, the workflow's owner or its runner.
    output: describedOutput(scope, step, runs.get(step.id) ?? null, standing.ownerId),
    condition: conditions.get(step.id)!,
    latestAttempt: attempts.get(step.id) ?? null,
    edges: edgesByStep.get(step.id) ?? [],
    reads: reads.get(step.id) ?? [],
  }));
  requireRecipe(scope, recipeId);
  return {
    recipe,
    facts,
    steps: views,
    summary: summarizeRecipe(views, artifacts),
    presence: presencesOf(scope, [standing])[0],
    context: {
      link: linkFilter(scope, [standing.ownerId]),
      reachesMap: (mapId) => canReach(scope, "map", mapId),
    },
  };
}

/** One step's view, for the surfaces that address a step directly. */
export async function readStep(
  scope: AccountScope,
  recipeId: string,
  stepId: string,
): Promise<StepView & { context: ReaderContext; facts: DocumentFacts }> {
  requireStep(scope, recipeId, stepId);
  const recipe = await readRecipe(scope, recipeId);
  return { ...recipe.steps.find((s) => s.step.id === stepId)!, context: recipe.context, facts: recipe.facts };
}

import type { LineageEdge } from "@/lib/metadata/lineage";
import type { RecipeStep } from "@/lib/metadata/recipes";
import { deriveStaleness, type StaleCause } from "./staleness";

/**
 * What condition a step is in.
 *
 * **A condition is not a job state.** published five job states and this spec
 * adds none: *stale*, *broken*, *output missing* and *never run* describe the
 * step, while queued/running/succeeded/failed/cancelled describe an attempt.
 * They are read together because they are genuinely independent — *fresh output,
 * latest attempt failed* is an ordinary situation, and a model that collapsed
 * them could not say it.
 *
 * **Conditions coexist.** A never-run step can lose an input; a stale step can
 * lose its output; a step can lose both at once. So every true condition is
 * reported and a surface picks what to show. Where one must be named first the
 * order is **broken, output missing, stale, never run, current** — un-runnable
 * before un-current, because offering a re-run that cannot succeed tells the
 * user the wrong thing.
 *
 * **Broken is transitive.** A step whose producer cannot run cannot run either,
 * so a deleted input breaks the steps that read it *and* everything downstream
 * of those. E6 says downstream steps go broken rather than deleted; this is how
 * far downstream that reaches.
 */

export type ConditionKind =
  | "broken"
  | "output_missing"
  | "stale"
  | "never_run"
  | "current";

/** Ordered as they are named: un-runnable before un-current. */
const PRECEDENCE: ConditionKind[] = [
  "broken",
  "output_missing",
  "stale",
  "never_run",
  "current",
];

export interface BrokenInput {
  tableId: string;
  tableName: string;
  /** Set when this step is broken because a producer upstream is. */
  throughStepId?: string;
}

export interface StepCondition {
  stepId: string;
  /** Every condition true of this step, in precedence order. */
  conditions: ConditionKind[];
  /** The first of them — what a one-word surface would show. */
  primary: ConditionKind;
  /** Why it is stale, when it is; empty otherwise. */
  causes: StaleCause[];
  /** What it lost, when it is broken; empty otherwise. */
  missingInputs: BrokenInput[];
}

/** A synthetic next-run edge is condition evidence, not recorded lineage. */
export type ConditionEdge = LineageEdge & { prospective?: true };

export interface ConditionInput {
  steps: RecipeStep[];
  edges: ConditionEdge[];
  /** The artifact each live table holds; a table absent here is deleted. */
  currentArtifact: Map<string, string>;
}

/**
 * Every step's condition, computed together.
 *
 * Together rather than one at a time because two of the five are relational:
 * broken travels down the chain, and staleness needs the whole graph. Steps are
 * visited in order, which is sound because dependencies may only point
 * backwards.
 */
export function deriveConditions(
  input: ConditionInput,
): Map<string, StepCondition> {
  const { steps, edges, currentArtifact } = input;
  const stale = deriveStaleness(input);

  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const edgesByStep = new Map<string, ConditionEdge[]>();
  for (const e of edges) {
    const list = edgesByStep.get(e.stepId);
    if (list) list.push(e);
    else edgesByStep.set(e.stepId, [e]);
  }
  const producerOf = new Map<string, RecipeStep>();
  for (const s of steps) if (s.outputTableId) producerOf.set(s.outputTableId, s);

  const out = new Map<string, StepCondition>();
  const brokenForDownstream = new Set<string>();

  for (const step of ordered) {
    const found = new Set<ConditionKind>();
    const missing: BrokenInput[] = [];
    let breaksDownstream = false;

    for (const edge of edgesByStep.get(step.id) ?? []) {
      const producer = producerOf.get(edge.inputTableId);

      // The input itself is gone.
      if (!currentArtifact.has(edge.inputTableId)) {
        found.add("broken");
        missing.push({ tableId: edge.inputTableId, tableName: edge.inputTableName });
        // A prospective edge describes only this step's pending or never-run
        // definition. If its published output still exists, a consumer can
        // run successfully on that artifact; cascading "cannot run" would be
        // false. Recorded lineage loss remains transitive exactly as before.
        if (!edge.prospective) breaksDownstream = true;
        continue;
      }
      // Or the step that produces it is broken, which breaks this one too.
      if (producer && brokenForDownstream.has(producer.id)) {
        found.add("broken");
        breaksDownstream = true;
        missing.push({
          tableId: edge.inputTableId,
          tableName: edge.inputTableName,
          throughStepId: producer.id,
        });
      }
    }

    if (breaksDownstream) brokenForDownstream.add(step.id);

    if (step.outputTableId === null) {
      found.add("never_run");
    } else if (!currentArtifact.has(step.outputTableId)) {
      // It produced something and that something has been deleted.
      found.add("output_missing");
    }

    const causes = stale.get(step.id) ?? [];
    if (causes.length > 0) found.add("stale");

    if (found.size === 0) found.add("current");

    const conditions = PRECEDENCE.filter((c) => found.has(c));
    out.set(step.id, {
      stepId: step.id,
      conditions,
      primary: conditions[0],
      causes,
      missingInputs: missing,
    });
  }

  return out;
}

/** Whether a step can be run at all — the question a surface asks before it
 * offers the control. */
export function isRunnable(condition: StepCondition): boolean {
  return !condition.conditions.includes("broken");
}

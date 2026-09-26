import { ApiError } from "@/lib/api/errors";
import { deriveTableName } from "@/lib/ingest/naming";
import type { RecipeStep } from "@/lib/metadata/recipes";

/**
 * The backward-only rule.
 *
 * A recipe's dependencies may point only at earlier steps. That makes it a
 * directed acyclic graph by construction rather than by cycle detection: if
 * every edge goes backwards in a total order, no cycle can exist, and the check
 * is a comparison of positions instead of a walk.
 *
 * **It is enforced when the change is made, on an edit and on a reorder alike.**
 * A reorder can put a producer after its consumer just as easily as an edit can
 * point a step at itself, and discovering either at run time means telling a
 * user their recipe is broken long after they broke it.
 *
 * This module is deliberately pure. Resolving which tables a step's SQL reads
 * needs the engine's parser; deciding whether those tables are legal here does
 * not, and keeping them apart means the rule can be tested exhaustively without
 * one.
 */

/** A step's position and the outputs it would read, as names. */
export interface OrderCheck {
  /** The step being placed or edited. */
  stepId: string;
  /** Where it will sit once the change lands. */
  ordinal: number;
  /** Table names the step reads, lower-cased. */
  reads: string[];
}

/**
 * Which step, if any, owns each table name in this recipe.
 *
 * **A step that has never run still owns a name.** It declares the dataset it
 * will produce, and both callers need the answer before anything has run: the
 * backward-only rule is enforced *at the edit*, and a cascade over a fresh
 * recipe has to know what its members depend on. Reading only the recorded
 * output would find no dependencies at all in a recipe nobody has run yet —
 * every arrangement legal, every member independent.
 */
function ownersByName(steps: RecipeStep[]): Map<string, RecipeStep> {
  const owners = new Map<string, RecipeStep>();
  // Through the same sanitizer the registry will apply, because that is the
  // name the consumer's SQL will have to write: a step declaring "Chain One"
  // produces `chain_one`, and matching on the raw text would find no dependency
  // until the producer had run — long enough for a reorder to be accepted or a
  // cascade to start the consumer early.
  const declared = (params: Record<string, unknown> | null): string | null =>
    params && typeof params.name === "string" && params.name !== ""
      ? deriveTableName(params.name, new Set())
      : null;
  for (const s of steps) {
    // Least specific first: what it has actually produced wins over what it
    // says it will, and a proposal is what it would produce next.
    for (const name of [
      declared(s.parameters),
      declared(s.proposedParameters),
      s.outputTableName,
    ]) {
      if (name) owners.set(name.toLowerCase(), s);
    }
  }
  return owners;
}

/**
 * The steps this one depends on, by id.
 *
 * A table a step reads is a dependency only when another step in the same
 * recipe produced it; everything else is an ordinary workspace input, including
 * a table produced by a step that has since been removed. That is exactly what
 * G3 means by a removed step's output becoming an ordinary input.
 */
export function dependenciesWithin(
  steps: RecipeStep[],
  reads: string[],
): RecipeStep[] {
  const owners = ownersByName(steps);
  const found = new Map<string, RecipeStep>();
  for (const name of reads) {
    const owner = owners.get(name.toLowerCase());
    if (owner) found.set(owner.id, owner);
  }
  return [...found.values()];
}

/**
 * Refuse a change that would make a step read itself or anything later.
 *
 * Throws rather than returning a verdict: every caller's response to an invalid
 * arrangement is the same coded refusal, and a boolean would invite one of them
 * to carry on regardless.
 */
export function assertBackwardOnly(
  steps: RecipeStep[],
  change: OrderCheck,
): void {
  const deps = dependenciesWithin(steps, change.reads);

  for (const dep of deps) {
    if (dep.id === change.stepId) {
      throw new ApiError(
        "invalid_request",
        `This step reads its own output ("${dep.outputTableName}"). A step may ` +
          `read workspace tables and the outputs of earlier steps only.`,
        400,
      );
    }
    if (dep.ordinal >= change.ordinal) {
      throw new ApiError(
        "invalid_request",
        `This step reads "${dep.outputTableName}", which a later step produces. ` +
          `A step may read workspace tables and the outputs of earlier steps ` +
          `only. Reorder them so the producer comes first.`,
        400,
      );
    }
  }
}

/**
 * Check a whole proposed ordering at once, which is what a reorder needs.
 *
 * A move can break a dependency belonging to a step that was not the one moved —
 * dragging a producer downwards breaks its consumers, not itself — so validating
 * only the moved step would pass a reorder that leaves the recipe invalid.
 *
 * `readsOf` gives the tables each step reads; steps whose reads are unknown are
 * skipped rather than assumed empty, so a caller that could only resolve some of
 * them does not get a false pass on the rest.
 */
export function assertOrderingValid(
  ordered: RecipeStep[],
  readsOf: Map<string, string[]>,
): void {
  const positioned = ordered.map((s, i) => ({ ...s, ordinal: i }));
  for (const step of positioned) {
    const reads = readsOf.get(step.id);
    if (reads === undefined) continue;
    assertBackwardOnly(positioned, {
      stepId: step.id,
      ordinal: step.ordinal,
      reads,
    });
  }
}

/**
 * The order an edit needs when a step comes to read a producer that stands
 * later: the reader moves to just after the latest of those producers, and
 * everything that depends on it (transitively, by the reads given) moves to
 * just after the latest of its own dependencies in the new order — not as
 * one block, since a dependent may also read a step that stands after the
 * producer. Every other step keeps its place; the moved
 * steps keep their relative order where the dependencies allow. The result
 * is checked as a whole by the caller. Pure.
 */
export function orderAfterProducers(
  steps: RecipeStep[],
  readerId: string,
  producerIds: string[],
  readsOf: Map<string, string[]>,
): RecipeStep[] {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const byId = new Map(ordered.map((s) => [s.id, s]));
  // The reader's dependents, transitively: any step that reads a table the
  // moving set owns.
  const moving = new Set<string>([readerId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of ordered) {
      if (moving.has(s.id)) continue;
      const deps = dependenciesWithin(ordered, readsOf.get(s.id) ?? []);
      if (deps.some((d) => moving.has(d.id))) {
        moving.add(s.id);
        grew = true;
      }
    }
  }
  const producers = producerIds.map((id) => byId.get(id)).filter((s): s is RecipeStep => s !== undefined);
  const anchor = producers.reduce((max, s) => (s.ordinal > max ? s.ordinal : max), -1);
  const result: RecipeStep[] = ordered.filter((s) => !moving.has(s.id));
  // Each moved step lands after the latest step it depends on, the reader
  // after its new producers, in their original order among themselves.
  const after = (deps: RecipeStep[]): number =>
    deps.reduce((max, d) => {
      const at = result.findIndex((s) => s.id === d.id);
      return at > max ? at : max;
    }, -1);
  for (const s of ordered.filter((x) => moving.has(x.id))) {
    const deps =
      s.id === readerId
        ? [...producers, ...dependenciesWithin(ordered, readsOf.get(s.id) ?? []).filter((d) => d.ordinal <= anchor)]
        : dependenciesWithin(ordered, readsOf.get(s.id) ?? []);
    result.splice(after(deps) + 1, 0, s);
  }
  return result;
}

/**
 * The read map the ordering and the removal answer work from: one step
 * whose SQL does not parse reads nothing, and every other step keeps its
 * reads. The strict reader rejects the whole map on one malformed step,
 * which would let a reorder pass validation against an empty map.
 */
export async function tolerantReadsByStep(
  steps: RecipeStep[],
  readsOf: (step: RecipeStep) => Promise<string[]>,
): Promise<Map<string, string[]>> {
  const entries = await Promise.all(
    steps.map(async (s) => [s.id, await readsOf(s).catch(() => [] as string[])] as const),
  );
  return new Map(entries);
}

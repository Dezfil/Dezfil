import type { recipePayload, stepPayload } from "@/lib/operations/recipe-api";

/**
 * What the drawer knows about a recipe.
 *
 * The types are **derived from the payload builders** rather than re-declared
 * beside them. A hand-written mirror of a published shape drifts silently, and
 * the drift surfaces as a field that is quietly always undefined — which is the
 * failure this feature is least able to see, since every one of its own
 * assertions would still pass.
 */

export type RecipeSummary = ReturnType<typeof recipePayload>;
export type StepSummary = ReturnType<typeof stepPayload>;
export type StepCondition = StepSummary["condition"];

/** The recipe's roll-up, worst first — un-runnable before un-current, which is
 * the order publishes conditions in. */
const ROLL_UP: StepCondition[] = [
  "broken",
  "output_missing",
  "stale",
  "never_run",
  "current",
];

/** The word a badge shows for a condition. Owns the row's own state
 * vocabulary; this is the roll-up's, and the two agree by using one list. */
export const CONDITION_WORD: Record<StepCondition, string> = {
  broken: "Broken",
  output_missing: "Output missing",
  stale: "Stale",
  never_run: "Not run",
  current: "Current",
};

/**
 * A recipe nobody has run.
 *
 * **It is not listed and does not count.** Pressing *Analyze…* mints a recipe
 * before the user has decided anything, so an index that listed every stored
 * recipe would fill with abandoned openings — the count on the topbar would
 * climb every time a user looked at the door and walked away.
 *
 * "Run" means *attempted*, not *succeeded*: a step whose only run failed is
 * still a recipe the user made and will come back to, and hiding it would hide
 * the failure with it.
 */
export function isDraft(recipe: RecipeSummary): boolean {
  return recipe.steps.every(
    (s) => s.latestAttempt === null && s.lastSuccessAt === null,
  );
}

/** The index's rows: every recipe that is not a draft, newest first. */
export function listedRecipes(recipes: RecipeSummary[]): RecipeSummary[] {
  return recipes
    .filter((r) => !isDraft(r))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The roll-up badge: the worst condition any of its steps is in. A recipe
 * with no steps has nothing to roll up. */
export function rollUp(recipe: RecipeSummary): StepCondition | null {
  if (recipe.steps.length === 0) return null;
  for (const kind of ROLL_UP) {
    if (recipe.steps.some((s) => s.conditions.includes(kind))) return kind;
  }
  return "current";
}

/** The layer a step was authored from, when it was. The origin is stored as an
 * open record, so this is where the two fields the surface needs are named. */
export function layerOrigin(
  step: StepSummary | undefined,
): { layerId: string; layerName: string; mapId: string } | null {
  const origin = step?.origin;
  if (!origin || typeof origin !== "object") return null;
  const { layerId, layerName, mapId } = origin as Record<string, unknown>;
  if (typeof layerId !== "string" || layerId === "") return null;
  return {
    layerId,
    layerName: typeof layerName === "string" ? layerName : "",
    // The map the layer belonged to. Liveness is resolved forwards, from the
    // maps that still exist, so this is what says which map to ask.
    mapId: typeof mapId === "string" ? mapId : "",
  };
}

/** What the index says a recipe started from. */
export type Origin =
  /** Authored from a layer that is still there. */
  | { kind: "layer"; layerId: string; name: string }
  /** Started from a workspace table rather than a layer. */
  | { kind: "table"; name: string }
  /** No layer behind it — either never one, or the layer is gone. */
  | { kind: "none" };

export const NO_STARTING_LAYER = "no starting layer";

/**
 * Where a recipe came from.
 *
 * **A gone layer reads as "no starting layer", never as its remembered name.**
 * The origin is a snapshot taken when the step was authored, so it goes on
 * naming a layer long after the layer is deleted; printing that name would
 * offer the user a place to go back to that no longer exists. Resolving it
 * against the live layers is what makes the deleted case honest — and it is why
 * this takes the liveness answer as an argument rather than reading the
 * snapshot alone.
 */
export function originOf(
  recipe: RecipeSummary,
  layerLives: (layerId: string) => boolean,
): Origin {
  const first = recipe.steps[0];
  const origin = layerOrigin(first);
  if (origin) {
    return layerLives(origin.layerId)
      ? { kind: "layer", layerId: origin.layerId, name: origin.layerName }
      : { kind: "none" };
  }
  const input = first?.inputs[0]?.name;
  if (typeof input === "string" && input !== "") {
    return { kind: "table", name: input };
  }
  return { kind: "none" };
}

export function originLabel(origin: Origin): string {
  return origin.kind === "none" ? NO_STARTING_LAYER : origin.name;
}

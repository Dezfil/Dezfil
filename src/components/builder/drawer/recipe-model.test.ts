import { describe, it, expect } from "vitest";
import {
  NO_STARTING_LAYER,
  isDraft,
  listedRecipes,
  originLabel,
  originOf,
  rollUp,
  type RecipeSummary,
  type StepSummary,
} from "./recipe-model";

/**
 * The recipe index's own rules.
 *
 * Every one of these decides something a user sees and could be wrong about:
 * which recipes exist at all, what a row says a recipe started from, and what
 * duplicating one actually asks the API for.
 */

function step(over: Partial<StepSummary> = {}): StepSummary {
  return {
    id: "s1",
    recipeId: "r1",
    ordinal: 0,
    operation: "buffer",
    parameters: {},
    proposedParameters: null,
    output: null,
    condition: "never_run",
    conditions: ["never_run"],
    causes: [],
    missingInputs: [],
    origin: null,
    inputs: [],
    latestAttempt: null,
    lastSuccessAt: null,
    ...over,
  } as StepSummary;
}

function recipe(over: Partial<RecipeSummary> = {}): RecipeSummary {
  return {
    id: "r1",
    name: "Recipe",
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
    steps: [],
    ...over,
  } as RecipeSummary;
}

const ran = { lastSuccessAt: "2026-08-13T10:05:00.000Z" };

describe("a draft nobody has run", () => {
  it("is not listed and does not count", () => {
    const drafts = [
      recipe({ id: "empty" }),
      recipe({ id: "authored", steps: [step()] }),
    ];
    expect(drafts.every(isDraft)).toBe(true);
    expect(listedRecipes(drafts)).toEqual([]);
  });

  it("stops being a draft on the attempt, not on the success", () => {
    // A recipe whose only run failed is one the user made and will come back
    // to. Hiding it until something succeeds would hide the failure with it.
    const failed = recipe({
      steps: [
        step({
          latestAttempt: {
            id: "j1",
            operation: "buffer",
            state: "failed",
            subject: { kind: "step", id: "s1" },
            parameters: {},
            acceptedAt: "2026-08-13T10:01:00.000Z",
            error: { code: "sql_rejected", message: "no" },
          },
        }),
      ],
    });
    expect(isDraft(failed)).toBe(false);
    expect(listedRecipes([failed])).toHaveLength(1);
  });

  it("lists the rest newest first", () => {
    const older = recipe({
      id: "older",
      updatedAt: "2026-08-13T09:00:00.000Z",
      steps: [step(ran)],
    });
    const newer = recipe({
      id: "newer",
      updatedAt: "2026-08-13T11:00:00.000Z",
      steps: [step(ran)],
    });
    expect(listedRecipes([older, newer]).map((r) => r.id)).toEqual([
      "newer",
      "older",
    ]);
  });
});

describe("the roll-up badge", () => {
  it("shows the worst condition any step is in, un-runnable first", () => {
    const mixed = recipe({
      steps: [
        step({ id: "a", condition: "current", conditions: ["current"] }),
        step({ id: "b", condition: "stale", conditions: ["stale"] }),
        step({ id: "c", condition: "broken", conditions: ["broken", "stale"] }),
      ],
    });
    expect(rollUp(mixed)).toBe("broken");
  });

  it("reads every condition of a step, not only its first", () => {
    // Conditions coexist, and a roll-up that read `primary` alone would
    // report a broken-and-stale recipe as merely broken's neighbour — here,
    // would miss the stale one entirely.
    const hidden = recipe({
      steps: [
        step({ id: "a", condition: "current", conditions: ["current"] }),
        step({
          id: "b",
          condition: "output_missing",
          conditions: ["output_missing", "stale"],
        }),
      ],
    });
    expect(rollUp(hidden)).toBe("output_missing");
  });

  it("has nothing to roll up when there are no steps", () => {
    expect(rollUp(recipe())).toBeNull();
  });
});

describe("what a row says the recipe started from", () => {
  const lives = () => true;
  const gone = () => false;

  it("names the starting layer while it is there", () => {
    const fromLayer = recipe({
      steps: [step({ origin: { layerId: "l1", layerName: "Stations" } })],
    });
    expect(originLabel(originOf(fromLayer, lives))).toBe("Stations");
  });

  it("says 'no starting layer' once that layer is deleted", () => {
    // Criterion 10. The origin is a snapshot and goes on naming the layer for
    // ever; printing that name would offer a place to go back to that is not
    // there. The recipe stays reachable — only its origin line changes.
    const orphan = recipe({
      steps: [step({ origin: { layerId: "l1", layerName: "Stations" } })],
    });
    expect(originLabel(originOf(orphan, gone))).toBe(NO_STARTING_LAYER);
  });

  it("names the origin table for a recipe started without a layer", () => {
    const fromTable = recipe({
      steps: [step({ inputs: [{ id: "t1", name: "stations" }] })],
    });
    expect(originLabel(originOf(fromTable, gone))).toBe("stations");
  });

  it("says 'no starting layer' for a recipe with nothing behind it", () => {
    expect(originLabel(originOf(recipe(), lives))).toBe(NO_STARTING_LAYER);
  });
});

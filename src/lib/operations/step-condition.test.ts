import { describe, it, expect } from "vitest";
import type { LineageEdge } from "@/lib/metadata/lineage";
import type { RecipeStep } from "@/lib/metadata/recipes";
import { deriveConditions, isRunnable } from "./step-condition";

function step(id: string, ordinal: number, output: string | null): RecipeStep {
  return {
    id,
    recipeId: "r",
    ordinal,
    operation: "sql_step",
    parameters: {},
    proposedParameters: null,
    outputTableId: output,
    outputTableName: output ? `${output}-name` : null,
    origin: null,
    proposedOrigin: null,
    lastSuccessAt: output ? "2026-08-12T00:00:00Z" : null,
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
  };
}

function edge(
  stepId: string,
  outputTableId: string,
  inputTableId: string,
  boundArtifact: string,
): LineageEdge {
  return {
    id: `${stepId}:${inputTableId}`,
    stepId,
    outputTableId,
    inputTableId,
    inputTableName: `${inputTableId}-name`,
    boundArtifact,
    recordedAt: "2026-08-12T00:00:00Z",
  };
}

/** Stations → A(joined) → B(summed) */
function chain() {
  return {
    steps: [step("A", 0, "joined"), step("B", 1, "summed")],
    edges: [
      edge("A", "joined", "stations", "stations@1"),
      edge("B", "summed", "joined", "joined@1"),
    ],
    currentArtifact: new Map([
      ["stations", "stations@1"],
      ["joined", "joined@1"],
      ["summed", "summed@1"],
    ]),
  };
}

const at = (m: Map<string, ReturnType<typeof deriveConditions> extends Map<string, infer V> ? V : never>, id: string) =>
  m.get(id)!;

describe("the ordinary conditions", () => {
  it("reports current when everything lines up", () => {
    const c = at(deriveConditions(chain()), "A");
    expect(c.conditions).toEqual(["current"]);
    expect(c.primary).toBe("current");
    expect(isRunnable(c)).toBe(true);
  });

  it("reports never run for a step that has produced nothing", () => {
    const world = chain();
    world.steps = [step("A", 0, null)];
    world.edges = [];
    expect(at(deriveConditions(world), "A").primary).toBe("never_run");
  });

  it("reports stale, with its causes", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");
    const c = at(deriveConditions(world), "A");
    expect(c.primary).toBe("stale");
    expect(c.causes.map((x) => x.reason)).toEqual(["source_changed"]);
  });

  it("reports output missing when the step's own output was deleted", () => {
    const world = chain();
    world.currentArtifact.delete("joined");
    expect(at(deriveConditions(world), "A").conditions).toContain("output_missing");
  });

  it("reports broken when an input was deleted, naming what was lost", () => {
    const world = chain();
    world.currentArtifact.delete("stations");
    const c = at(deriveConditions(world), "A");
    expect(c.primary).toBe("broken");
    expect(c.missingInputs.map((m) => m.tableName)).toEqual(["stations-name"]);
    // A step that cannot run must not be offered a run.
    expect(isRunnable(c)).toBe(false);
  });
});

describe("conditions coexist", () => {
  it("a step can be broken and output-missing at once, broken named first", () => {
    const world = chain();
    world.currentArtifact.delete("stations"); // its input
    world.currentArtifact.delete("joined"); // its own output

    const c = at(deriveConditions(world), "A");
    expect(c.conditions).toEqual(["broken", "output_missing"]);
    expect(c.primary).toBe("broken");
  });

  it("a never-run step can also be broken", () => {
    const steps = [step("A", 0, null)];
    const edges = [edge("A", "unused", "stations", "stations@1")];
    const c = at(
      deriveConditions({ steps, edges, currentArtifact: new Map() }),
      "A",
    );
    expect(c.conditions).toEqual(["broken", "never_run"]);
  });

  it("a stale step that also lost its output reports both", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2"); // A is stale
    world.currentArtifact.delete("joined"); // and its output is gone

    const c = at(deriveConditions(world), "A");
    expect(c.conditions).toEqual(["output_missing", "stale"]);
    expect(c.primary).toBe("output_missing");
  });
});

describe("broken is transitive", () => {
  it("keeps prospective missing-input breakage on its own step", () => {
    const world = chain();
    const edges = [
      {
        ...edge("A", "joined", "missing:future", ""),
        id: "prospective:A:future",
        prospective: true as const,
      },
      edge("B", "summed", "joined", "joined@1"),
    ];

    const all = deriveConditions({ ...world, edges });
    expect(at(all, "A").primary).toBe("broken");
    expect(at(all, "B").primary).toBe("current");
  });

  it("reaches a step two hops from the deleted table", () => {
    const steps = [step("A", 0, "t1"), step("B", 1, "t2"), step("C", 2, "t3")];
    const edges = [
      edge("A", "t1", "source", "source@1"),
      edge("B", "t2", "t1", "t1@1"),
      edge("C", "t3", "t2", "t2@1"),
    ];
    const currentArtifact = new Map([
      // `source` is deleted; t1..t3 all still exist.
      ["t1", "t1@1"],
      ["t2", "t2@1"],
      ["t3", "t3@1"],
    ]);

    const all = deriveConditions({ steps, edges, currentArtifact });
    expect(at(all, "A").primary).toBe("broken");
    expect(at(all, "B").primary).toBe("broken");
    expect(at(all, "C").primary).toBe("broken");
    // And each downstream one says which producer it came through.
    expect(at(all, "C").missingInputs[0].throughStepId).toBe("B");
  });

  it("does not break a sibling that reads something else", () => {
    const steps = [step("A", 0, "t1"), step("S", 1, "t9")];
    const edges = [
      edge("A", "t1", "gone", "gone@1"),
      edge("S", "t9", "safe", "safe@1"),
    ];
    const currentArtifact = new Map([
      ["safe", "safe@1"],
      ["t1", "t1@1"],
      ["t9", "t9@1"],
    ]);

    const all = deriveConditions({ steps, edges, currentArtifact });
    expect(at(all, "A").primary).toBe("broken");
    expect(at(all, "S").primary).toBe("current");
  });
});

describe("condition is independent of job state", () => {
  it("says nothing about attempts — a current step is current whatever ran last", () => {
    // The condition model has no field for an attempt, which is the point:
    // "fresh output, latest attempt failed" is expressed by reading the two
    // separately rather than by collapsing them into one word.
    const c = at(deriveConditions(chain()), "A");
    expect(Object.keys(c)).not.toContain("state");
    expect(c.conditions).toEqual(["current"]);
  });
});

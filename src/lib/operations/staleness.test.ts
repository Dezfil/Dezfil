import { describe, it, expect } from "vitest";
import type { LineageEdge } from "@/lib/metadata/lineage";
import type { RecipeStep } from "@/lib/metadata/recipes";
import { deriveStaleness, causesFor, isStale } from "./staleness";

/**
 * The staleness rule, exhaustively.
 *
 * The scenario throughout: `stations` (an imported table) → step A produces
 * `joined` → step B produces `summed`. That is the smallest shape that can show
 * all three causes and tell them apart.
 */

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

/** A → reads `stations`; B → reads A's output. */
function chain() {
  const steps = [step("A", 0, "joined"), step("B", 1, "summed")];
  const edges = [
    edge("A", "joined", "stations", "stations@1"),
    edge("B", "summed", "joined", "joined@1"),
  ];
  const currentArtifact = new Map([
    ["stations", "stations@1"],
    ["joined", "joined@1"],
    ["summed", "summed@1"],
  ]);
  return { steps, edges, currentArtifact };
}

describe("nothing is stale when every artifact matches what was bound", () => {
  it("reports no causes anywhere", () => {
    const derived = deriveStaleness(chain());
    expect(causesFor(derived, "A")).toEqual([]);
    expect(causesFor(derived, "B")).toEqual([]);
    expect(isStale(derived, "A")).toBe(false);
  });

  it("a step that has produced nothing is not stale — that is a different condition", () => {
    const world = chain();
    world.steps = [step("A", 0, null)];
    world.edges = [];
    expect(causesFor(deriveStaleness(world), "A")).toEqual([]);
  });
});

describe("source changed", () => {
  it("marks the step that read a refreshed import", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");

    const derived = deriveStaleness(world);
    expect(causesFor(derived, "A")).toEqual([
      {
        reason: "source_changed",
        tableId: "stations",
        tableName: "stations-name",
      },
    ]);
  });

  it("does not mark a step that reads a different table", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");
    // B reads `joined`, which is untouched — its own cause comes from A.
    expect(
      causesFor(deriveStaleness(world), "B").map((c) => c.reason),
    ).toEqual(["upstream_stale"]);
  });
});

describe("upstream re-ran", () => {
  it("marks a consumer whose producer published a new artifact", () => {
    const world = chain();
    // A re-ran: `joined` now holds a newer artifact than B bound.
    world.currentArtifact.set("joined", "joined@2");

    const derived = deriveStaleness(world);
    expect(causesFor(derived, "A")).toEqual([]);
    expect(causesFor(derived, "B")).toEqual([
      {
        reason: "upstream_re_ran",
        tableId: "joined",
        tableName: "joined-name",
        producedByStepId: "A",
      },
    ]);
  });

  it("is told apart from source changed by whether a step produces the input", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");
    world.currentArtifact.set("joined", "joined@2");

    const derived = deriveStaleness(world);
    // Same mechanism, different word, because `stations` has no producer.
    expect(causesFor(derived, "A")[0].reason).toBe("source_changed");
    expect(causesFor(derived, "B")[0].reason).toBe("upstream_re_ran");
  });
});

describe("upstream stale", () => {
  it("propagates from a stale producer whose artifact has not moved", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");

    const derived = deriveStaleness(world);
    // A is stale because its source changed; B's input artifact is unchanged,
    // so B is stale for the *other* reason.
    expect(causesFor(derived, "A")[0].reason).toBe("source_changed");
    expect(causesFor(derived, "B")).toEqual([
      {
        reason: "upstream_stale",
        tableId: "joined",
        tableName: "joined-name",
        producedByStepId: "A",
      },
    ]);
  });

  it("travels the length of a chain", () => {
    const steps = [
      step("A", 0, "t1"),
      step("B", 1, "t2"),
      step("C", 2, "t3"),
    ];
    const edges = [
      edge("A", "t1", "source", "source@1"),
      edge("B", "t2", "t1", "t1@1"),
      edge("C", "t3", "t2", "t2@1"),
    ];
    const currentArtifact = new Map([
      ["source", "source@2"], // refreshed
      ["t1", "t1@1"],
      ["t2", "t2@1"],
      ["t3", "t3@1"],
    ]);

    const derived = deriveStaleness({ steps, edges, currentArtifact });
    expect(causesFor(derived, "A")[0].reason).toBe("source_changed");
    expect(causesFor(derived, "B")[0].reason).toBe("upstream_stale");
    expect(causesFor(derived, "C")[0].reason).toBe("upstream_stale");
  });
});

describe("every active cause is reported (G2)", () => {
  it("reports two causes when a step has two", () => {
    // C reads both a refreshed import and a re-run step's output.
    const steps = [step("A", 0, "joined"), step("C", 1, "merged")];
    const edges = [
      edge("A", "joined", "stations", "stations@1"),
      edge("C", "merged", "stations", "stations@1"),
      edge("C", "merged", "joined", "joined@1"),
    ];
    const currentArtifact = new Map([
      ["stations", "stations@2"], // refreshed
      ["joined", "joined@2"], // A re-ran
      ["merged", "merged@1"],
    ]);

    const causes = causesFor(deriveStaleness({ steps, edges, currentArtifact }), "C");
    // Three, not two. A's output moved under C — and A is *itself* out of date,
    // because the table it read was refreshed and it has not re-run since. Both
    // are true of C at once, and reporting only the first is the single-reason
    // model this spec's gate rejected.
    expect(causes.map((c) => c.reason).sort()).toEqual([
      "source_changed",
      "upstream_re_ran",
      "upstream_stale",
    ]);
    // Each names where it came from, which is what makes several causes useful
    // rather than merely numerous.
    expect([...new Set(causes.map((c) => c.tableId))].sort()).toEqual([
      "joined",
      "stations",
    ]);
  });

  it("does not stop at the first cause a single input carries", () => {
    // The narrower shape of the same rule: one edge, two reasons. A producer
    // re-ran *and* is stale, so the consumer is behind for two separate
    // reasons — and a re-run of the consumer alone would answer neither
    // completely.
    const steps = [step("P", 0, "produced"), step("C", 1, "consumed")];
    const edges = [
      edge("P", "produced", "source", "source@1"),
      edge("C", "consumed", "produced", "produced@1"),
    ];
    const currentArtifact = new Map([
      ["source", "source@2"], // P's own input moved after P last ran
      ["produced", "produced@2"], // …and P re-ran at some point
      ["consumed", "consumed@1"],
    ]);

    const causes = causesFor(deriveStaleness({ steps, edges, currentArtifact }), "C");
    expect(causes.map((c) => c.reason).sort()).toEqual([
      "upstream_re_ran",
      "upstream_stale",
    ]);
    expect(causes.every((c) => c.producedByStepId === "P")).toBe(true);
  });
});

describe("a deleted input is not staleness", () => {
  it("is left to the broken condition rather than reported as out of date", () => {
    const world = chain();
    world.currentArtifact.delete("stations");

    // Offering a re-run for a step whose input is gone would be offering
    // something that cannot succeed.
    expect(causesFor(deriveStaleness(world), "A")).toEqual([]);
  });
});

describe("clearing", () => {
  it("clears exactly the cause a re-run answered, and no more", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");
    expect(isStale(deriveStaleness(world), "A")).toBe(true);

    // A re-runs: it rebinds `stations` at its current artifact.
    world.edges = world.edges.map((e) =>
      e.stepId === "A" ? { ...e, boundArtifact: "stations@2" } : e,
    );
    // Its own output is republished, so B now trails it.
    world.currentArtifact.set("joined", "joined@2");

    const derived = deriveStaleness(world);
    expect(causesFor(derived, "A")).toEqual([]);
    // And B is stale for the right reason — the re-run, not the refresh.
    expect(causesFor(derived, "B")[0].reason).toBe("upstream_re_ran");
  });

  it("does not clear an unresolved upstream when a step re-runs", () => {
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");

    // B re-runs against A's *unchanged* output while A is still stale.
    world.edges = world.edges.map((e) =>
      e.stepId === "B" ? { ...e, boundArtifact: "joined@1" } : e,
    );

    const derived = deriveStaleness(world);
    expect(causesFor(derived, "A")[0].reason).toBe("source_changed");
    // B ran, but what it read is still produced by something out of date.
    expect(causesFor(derived, "B")[0].reason).toBe("upstream_stale");
  });
});

describe("a change arriving mid-run survives that run", () => {
  it("is stale the moment the run lands, because the run binds the old artifact", () => {
    // The run began when `stations` held @1 and finishes after it became @2.
    const world = chain();
    world.currentArtifact.set("stations", "stations@2");
    // The finishing run writes the edge it actually bound.
    world.edges = world.edges.map((e) =>
      e.stepId === "A" ? { ...e, boundArtifact: "stations@1" } : e,
    );

    // No timing rule is needed: the mismatch is simply there.
    expect(causesFor(deriveStaleness(world), "A")[0].reason).toBe("source_changed");
  });
});

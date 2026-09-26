import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { RecipeStep } from "@/lib/metadata/recipes";
import {
  assertBackwardOnly,
  assertOrderingValid,
  dependenciesWithin,
  orderAfterProducers,
  tolerantReadsByStep,
} from "./recipe-order";

/** A step at a position, optionally owning an output table by name. */
function step(id: string, ordinal: number, output?: string): RecipeStep {
  return {
    id,
    recipeId: "r",
    ordinal,
    operation: "sql_step",
    parameters: {},
    proposedParameters: null,
    outputTableId: output ? `${id}-table` : null,
    outputTableName: output ?? null,
    origin: null,
    proposedOrigin: null,
    lastSuccessAt: null,
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
  };
}

const chain = () => [
  step("s1", 0, "joined"),
  step("s2", 1, "summed"),
  step("s3", 2, "final"),
];

/** A step that has never run, declaring the name it will produce. */
function declaring(id: string, ordinal: number, name: string): RecipeStep {
  return { ...step(id, ordinal), parameters: { sql: "SELECT 1", name } };
}

describe("a recipe nobody has run yet", () => {
  const fresh = () => [
    declaring("s1", 0, "joined"),
    declaring("s2", 1, "summed"),
  ];

  it("counts a declared output as a dependency", () => {
    // Reading only recorded outputs would find nothing here, and the rule is
    // enforced *at the edit* — long before anything has produced a table.
    expect(dependenciesWithin(fresh(), ["joined"]).map((d) => d.id)).toEqual(["s1"]);
  });

  it("still refuses a step that would read a later one's declared output", () => {
    expect(() =>
      assertBackwardOnly(fresh(), { stepId: "s1", ordinal: 0, reads: ["summed"] }),
    ).toThrow(ApiError);
  });

  it("still refuses a step that would read its own declared output", () => {
    expect(() =>
      assertBackwardOnly(fresh(), { stepId: "s1", ordinal: 0, reads: ["joined"] }),
    ).toThrow(ApiError);
  });
});

describe("what counts as a dependency", () => {
  it("only tables another step in this recipe produced", () => {
    const deps = dependenciesWithin(chain(), ["joined", "stations", "boroughs"]);
    expect(deps.map((d) => d.id)).toEqual(["s1"]);
  });

  it("matches case-insensitively, as the engine binds names", () => {
    expect(dependenciesWithin(chain(), ["JOINED"]).map((d) => d.id)).toEqual(["s1"]);
  });

  it("counts a step once however many times it is read", () => {
    expect(dependenciesWithin(chain(), ["joined", "joined"])).toHaveLength(1);
  });

  it("treats a table no step owns as an ordinary workspace input", () => {
    // This is what a removed step's output becomes (G3).
    expect(dependenciesWithin(chain(), ["orphaned_output"])).toEqual([]);
  });

  it("ignores steps that have produced nothing yet", () => {
    const steps = [step("s1", 0), step("s2", 1)];
    expect(dependenciesWithin(steps, ["anything"])).toEqual([]);
  });
});

describe("the backward-only rule", () => {
  it("allows reading an earlier step's output", () => {
    expect(() =>
      assertBackwardOnly(chain(), { stepId: "s3", ordinal: 2, reads: ["joined"] }),
    ).not.toThrow();
  });

  it("allows reading only workspace tables", () => {
    expect(() =>
      assertBackwardOnly(chain(), { stepId: "s1", ordinal: 0, reads: ["stations"] }),
    ).not.toThrow();
  });

  it("refuses a step that reads its own output", () => {
    try {
      assertBackwardOnly(chain(), { stepId: "s1", ordinal: 0, reads: ["joined"] });
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("invalid_request");
      expect((e as ApiError).message).toMatch(/its own output/i);
    }
  });

  it("refuses a step that reads a later step's output", () => {
    try {
      assertBackwardOnly(chain(), { stepId: "s1", ordinal: 0, reads: ["final"] });
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ApiError).code).toBe("invalid_request");
      expect((e as ApiError).message).toMatch(/a later step produces/i);
    }
  });

  it("refuses reading a step at the same position, which is the same step", () => {
    expect(() =>
      assertBackwardOnly(chain(), { stepId: "sX", ordinal: 1, reads: ["summed"] }),
    ).toThrow(ApiError);
  });

  it("permits a diamond — two steps reading one earlier producer", () => {
    const steps = [
      step("root", 0, "base"),
      step("left", 1, "l"),
      step("right", 2, "r"),
      step("merge", 3, "m"),
    ];
    expect(() =>
      assertBackwardOnly(steps, { stepId: "left", ordinal: 1, reads: ["base"] }),
    ).not.toThrow();
    expect(() =>
      assertBackwardOnly(steps, { stepId: "right", ordinal: 2, reads: ["base"] }),
    ).not.toThrow();
    // And the step that reads both sides of the diamond.
    expect(() =>
      assertBackwardOnly(steps, { stepId: "merge", ordinal: 3, reads: ["l", "r"] }),
    ).not.toThrow();
  });
});

describe("validating a whole proposed ordering — what a reorder needs", () => {
  const reads = new Map<string, string[]>([
    ["s1", ["stations"]],
    ["s2", ["joined"]],
    ["s3", ["summed"]],
  ]);

  it("accepts the order the chain was built in", () => {
    expect(() => assertOrderingValid(chain(), reads)).not.toThrow();
  });

  it("refuses a move that puts a producer after its consumer", () => {
    // Dragging s1 (which produces "joined") to the end breaks s2, not s1 —
    // which is why validating only the moved step would pass this.
    const moved = [step("s2", 0, "summed"), step("s3", 1, "final"), step("s1", 2, "joined")];
    expect(() => assertOrderingValid(moved, reads)).toThrow(ApiError);
  });

  it("skips steps whose reads are unknown rather than assuming none", () => {
    // A caller that resolved only some steps must not get a false pass on the
    // rest — the arrangement is invalid but unknowable here.
    const moved = [step("s2", 0, "summed"), step("s1", 1, "joined")];
    expect(() => assertOrderingValid(moved, new Map())).not.toThrow();
    // With the read known, the same arrangement is refused.
    expect(() =>
      assertOrderingValid(moved, new Map([["s2", ["joined"]]])),
    ).toThrow(ApiError);
  });
});

describe("the tolerant read map", () => {
  it("keeps every other step's reads when one step's SQL cannot be read", async () => {
    const steps = [
      { id: "a", ordinal: 0 },
      { id: "bad", ordinal: 1 },
      { id: "c", ordinal: 2 },
    ] as unknown as Parameters<typeof tolerantReadsByStep>[0];
    const readsOf = async (s: { id: string }) => {
      if (s.id === "bad") throw new Error("cannot parse");
      return [`${s.id}_in`];
    };
    const map = await tolerantReadsByStep(steps, readsOf as never);
    expect(map.get("a")).toEqual(["a_in"]);
    expect(map.get("bad")).toEqual([]);
    expect(map.get("c")).toEqual(["c_in"]);
  });
});

describe("the order an edit needs", () => {
  it("places a dependent that also reads a step after the producer after both, not in a block with the reader", () => {
    // reader(0) → producer(1) → other(2) → dependent(3), where dependent
    // reads the reader's output and other's. The reader comes to read the
    // producer: a block move would put dependent before other and fail
    // validation; the valid order is producer, reader, other, dependent.
    const steps = [step("reader", 0, "r_out"), step("producer", 1, "p_out"), step("other", 2, "o_out"), step("dependent", 3, "d_out")];
    const reads = new Map<string, string[]>([
      ["reader", ["p_out"]],
      ["producer", []],
      ["other", []],
      ["dependent", ["r_out", "o_out"]],
    ]);
    const order = orderAfterProducers(steps, "reader", ["producer"], reads).map((s) => s.id);
    expect(order).toEqual(["producer", "reader", "other", "dependent"]);
    const reordered = order.map((id, i) => step(id, i, steps.find((s) => s.id === id)!.outputTableName ?? undefined));
    expect(() => assertOrderingValid(reordered, reads)).not.toThrow();
  });
});

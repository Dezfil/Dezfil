import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "./openapi";
import { ERROR_CATALOGUE } from "./error-catalogue";
import { buildTools } from "@/lib/tools/tools";

/**
 * The published surface of.
 *
 * **This inventory is the completeness check, and parity is not.** Parity
 * compares implemented routes to documented ones and derives the tool set from
 * that same document, so a capability missing from *both* stays green through
 * all three of its sweeps. What closes that hole is a list written out from the
 * spec — here — asserted before the sweeps are trusted for anything.
 *
 * Every row below is a promise the contract makes in prose. Reading them out of the
 * implementation would make the check unfalsifiable, which is the whole reason
 * they are typed here by hand.
 */

interface Capability {
  /** What the contract promises, in its own words. */
  promise: string;
  method: string;
  path: string;
  tool: string;
}

const PROMISED: Capability[] = [
  {
    promise: "creating a recipe",
    method: "post",
    path: "/api/recipes",
    tool: "create_recipe",
  },
  {
    promise: "listing recipes",
    method: "get",
    path: "/api/recipes",
    tool: "list_recipes",
  },
  {
    promise: "reading a recipe",
    method: "get",
    path: "/api/recipes/{id}",
    tool: "get_recipe",
  },
  {
    promise: "renaming a recipe",
    method: "patch",
    path: "/api/recipes/{id}",
    tool: "update_recipe",
  },
  {
    promise: "deleting a recipe",
    method: "delete",
    path: "/api/recipes/{id}",
    tool: "delete_recipe",
  },
  {
    // a copy that can run, through the API.
    promise: "duplicating a recipe",
    method: "post",
    path: "/api/recipes/{id}/duplicate",
    tool: "duplicate_recipe",
  },
  {
    // the canvas layout document, beside the recipe.
    promise: "reading a recipe's layout",
    method: "get",
    path: "/api/recipes/{id}/layout",
    tool: "get_recipe_layout",
  },
  {
    promise: "replacing a recipe's layout",
    method: "put",
    path: "/api/recipes/{id}/layout",
    tool: "set_recipe_layout",
  },
  {
    promise: "adding a step",
    method: "post",
    path: "/api/recipes/{id}/steps",
    tool: "add_recipe_step",
  },
  {
    promise: "reading a step's condition, causes and history",
    method: "get",
    path: "/api/recipes/{id}/steps/{stepId}",
    tool: "get_recipe_step",
  },
  {
    promise: "editing a step",
    method: "patch",
    path: "/api/recipes/{id}/steps/{stepId}",
    tool: "update_recipe_step",
  },
  {
    promise: "removing a step",
    method: "delete",
    path: "/api/recipes/{id}/steps/{stepId}",
    tool: "remove_recipe_step",
  },
  {
    // a pending edit put back in one call.
    promise: "discarding a step's pending edit",
    method: "delete",
    path: "/api/recipes/{id}/steps/{stepId}/proposal",
    tool: "discard_recipe_step_edit",
  },
  {
    promise: "reordering a step",
    method: "post",
    path: "/api/recipes/{id}/steps/{stepId}/move",
    tool: "move_recipe_step",
  },
  {
    promise: "running a step",
    method: "post",
    path: "/api/recipes/{id}/steps/{stepId}/run",
    tool: "run_recipe_step",
  },
  {
    promise: "running a cascade, or a whole recipe",
    method: "post",
    path: "/api/recipes/{id}/runs",
    tool: "run_recipe",
  },
  {
    promise: "listing a recipe's runs",
    method: "get",
    path: "/api/recipes/{id}/runs",
    tool: "list_recipe_runs",
  },
  {
    promise: "reading a recipe run",
    method: "get",
    path: "/api/recipes/{id}/runs/{runId}",
    tool: "get_recipe_run",
  },
  {
    promise: "cancelling a recipe run",
    method: "post",
    path: "/api/recipes/{id}/runs/{runId}/cancel",
    tool: "cancel_recipe_run",
  },
];

type Operation = { "x-tool"?: string | false; description?: string };
const doc = () =>
  buildOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, Operation>>;
  };

describe("every promised capability is published", () => {
  for (const capability of PROMISED) {
    it(`${capability.promise} — ${capability.method.toUpperCase()} ${capability.path}`, () => {
      const operation = doc().paths[capability.path]?.[capability.method];
      expect(operation, `${capability.method} ${capability.path}`).toBeDefined();
      expect(operation?.["x-tool"]).toBe(capability.tool);
    });
  }

  it("and each is reachable as an agent tool", () => {
    const tools = new Set(buildTools().map((t) => t.name));
    const missing = PROMISED.map((c) => c.tool).filter((t) => !tools.has(t));
    expect(missing).toEqual([]);
  });
});

describe("the confirmation property", () => {
  const confirmOf = (path: string, method: string) =>
    (doc().paths[path]?.[method] as { "x-confirm"?: unknown })?.["x-confirm"];

  it("declares confirmation for a recipe deletion, disclosing that the tables remain", () => {
    expect(confirmOf("/api/recipes/{id}", "delete")).toBe(true);
    // The disclosure is the point of the confirmation, not decoration on it.
    expect(doc().paths["/api/recipes/{id}"].delete.description).toMatch(
      /datasets its steps produced remain/i,
    );
  });

  it("declares it conditionally for a run, which is wide or not by what it is aimed at", () => {
    // Run all and a re-run carrying dependents are wide; the same request on a
    // leaf carries only itself. One boolean cannot say that, so the operation
    // says `when_wide` and answers its own plan.
    expect(confirmOf("/api/recipes/{id}/runs", "post")).toBe("when_wide");
    expect(doc().paths["/api/recipes/{id}/runs"].post.description).toMatch(
      /plan: true/,
    );
  });

  it("declares nothing for running a single step, which carries only itself", () => {
    expect(
      confirmOf("/api/recipes/{id}/steps/{stepId}/run", "post"),
    ).toBeUndefined();
  });

  it("declares nothing for a duplicate, which touches neither the original nor its datasets", () => {
    expect(confirmOf("/api/recipes/{id}/duplicate", "post")).toBeUndefined();
    expect(doc().paths["/api/recipes/{id}/duplicate"].post.description).toMatch(
      /original and its datasets are unchanged/i,
    );
  });
});

describe("what the workflows page reads is documented", () => {
  const schemas = () =>
    (buildOpenApiDocument() as unknown as { components: { schemas: Record<string, { properties?: Record<string, unknown> }> } }).components.schemas;
  it("the recipe carries its origin and its summary; the step its present reads", () => {
    expect(schemas().Recipe.properties).toHaveProperty("origin");
    expect(schemas().Recipe.properties).toHaveProperty("summary");
    expect(schemas().RecipeSummary.properties).toHaveProperty("status");
    expect(schemas().RecipeStep.properties).toHaveProperty("reads");
  });
  it("the list takes an origin filter and creation an origin", () => {
    const list = doc().paths["/api/recipes"].get as { parameters?: { name: string }[] };
    expect(list.parameters?.map((p) => p.name)).toContain("origin");
    const create = doc().paths["/api/recipes"].post as { requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } };
    expect(create.requestBody?.content["application/json"].schema.properties).toHaveProperty("origin");
  });
});

describe("the error catalogue's delta", () => {
  /**
   * What had documented before this spec. Written out rather than read from
   * anywhere, so "added exactly one code" is a claim about this spec and
   * not a comparison of the implementation with itself.
   */
  const BEFORE_THIS_SPEC = [
    "operation_timeout",
    "operation_queue_full",
    "operation_interrupted",
  ];
  /** G6's ruling: the approved new-code set is exactly one code. */
  const APPROVED_AT_THIS_GATE = ["operation_superseded"];

  it("gains exactly the codes the gate approved, and no others", () => {
    const now = Object.keys(ERROR_CATALOGUE).filter((c) =>
      c.startsWith("operation_"),
    );
    const added = now.filter((c) => !BEFORE_THIS_SPEC.includes(c)).sort();
    expect(added).toEqual([...APPROVED_AT_THIS_GATE].sort());
    // And it is documented, not merely declared.
    for (const code of APPROVED_AT_THIS_GATE) {
      expect(ERROR_CATALOGUE[code as keyof typeof ERROR_CATALOGUE].length)
        .toBeGreaterThan(20);
    }
  });

  it("adds no job state alongside it (G5, G6)", () => {
    // A sixth state would show up here as a code named for one.
    const stateish = Object.keys(ERROR_CATALOGUE).filter((c) =>
      /cancelling|superseding|pausing/.test(c),
    );
    expect(stateish).toEqual([]);
  });
});

describe("the run contract says what a caller may rely on", () => {
  // Stated by hand, beside the parity check: a promise absent from both
  // OpenAPI and the tools cannot pass by parity alone.
  const doc = buildOpenApiDocument();
  const run = doc.paths["/api/recipes/{id}/runs"]?.post as { description?: string; parameters?: unknown[] } | undefined;
  const readRun = doc.paths["/api/recipes/{id}/runs/{runId}"]?.get as { description?: string } | undefined;
  const stepRun = doc.paths["/api/recipes/{id}/steps/{stepId}/run"]?.post as { description?: string } | undefined;
  const cancelRun = doc.paths["/api/recipes/{id}/runs/{runId}/cancel"]?.post as { description?: string } | undefined;
  const ordinaryRefusal =
    "Ordinarily, a step the API cannot admit alone is refused before anything " +
    "exists: no run, no attempt. Narrow exception: if the run was already " +
    "listable and cancellation was accepted before that refusal, the cancelled " +
    "run remains with the refusal member and no attempt.";
  const cancellationOrder =
    "Every member found running when cancellation is accepted is cancelled " +
    "before any member settlement is awaited; only a member already terminal " +
    "at acceptance stays finished, and its output stands.";
  it("a step's own run is one of the recipe's runs, and an inadmissible one mints nothing", () => {
    expect(stepRun?.description).toMatch(/one of the recipe's runs/);
    expect(stepRun?.description).toContain(ordinaryRefusal);
    expect(stepRun?.description).toMatch(/after the step is removed/);
  });
  it("publishes the batch cancellation order unchanged through the API and tool", () => {
    expect(cancelRun?.description).toContain(cancellationOrder);
    const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
    expect(tools.get("cancel_recipe_run")?.description).toContain(cancellationOrder);
    expect(tools.get("run_recipe_step")?.description).toContain(ordinaryRefusal);
  });
  it("one run at a time, named", () => {
    expect(run?.description).toMatch(/one run at a time/);
    expect(run?.description).toMatch(/run_in_flight/);
    expect(run?.description).toMatch(/two starts that race yield one run/);
  });
  it("a confirmed membership and the current revision both constrain a start", () => {
    expect(run?.description).toMatch(/plan_changed/);
    expect(run?.description).toMatch(/membership check accompanies the start revision check/);
    expect(run?.description).toMatch(/stale_revision before any run or output exists/);
    expect(run?.parameters).toContainEqual(expect.objectContaining({ name: "X-Edit-Revision", in: "header", required: false }));
    expect(doc.components.schemas.RecipeRunPlan.required).toContain("editRevision");
  });
  it("each attempted member carries its attempt, kept past pruning; a member never attempted has none; identity survives removal", () => {
    expect(run?.description).toMatch(/carries its attempt/);
    expect(run?.description).toMatch(/after the step's own history is pruned/);
    expect(run?.description).toMatch(/never attempted has none/);
    expect(run?.description).toMatch(/after the step is removed/);
    const member = (doc.components?.schemas?.RecipeRunMember as { properties?: Record<string, unknown> })?.properties ?? {};
    expect(Object.keys(member)).toEqual(expect.arrayContaining(["operation", "name", "output", "attempt"]));
    void readRun;
  });
});

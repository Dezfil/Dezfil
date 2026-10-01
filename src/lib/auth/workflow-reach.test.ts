import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileRecipe } from "@/lib/metadata/projects";
import { cascadeSettled, startCascade } from "@/lib/operations/cascade";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "./scope";

/**
 * A workflow read by someone it is shared with. Ada files `roads` and her
 * workflow W in project P, where Bob is a viewer and Edd an editor; she keeps
 * `parks` to herself; Bob owns a `roads` of his own; Cyd belongs to nothing.
 * W stages Ada's roads, reads its own staged output, and copies her parks.
 * Ada has run it, so its outputs are hers, filed in P.
 *
 * Whoever reaches W reads it in Ada's home within their own reach: Bob's view
 * binds `roads` to Ada's, never his own, reads the outputs he reaches, and
 * names `parks`, out of his reach, as written with the resource diagnostic,
 * leaving out the lineage that would name it. Cyd sees nothing.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let steps: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "workflow-reach-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["ada", "bob", "edd", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "viewer"], ["edd", "editor"]], [tables["ada.roads"].id]);
  const recipe = createRecipe(scopes.ada, "Survey");
  fileRecipe(recipe.id, "P");
  steps = {
    staged: addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } }).id,
    final: addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM staged", name: "final" } }).id,
    copy: addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM parks", name: "park_copy" } }).id,
    recipe: recipe.id,
  };
  const run = await startCascade(scopes.ada, { recipeId: recipe.id });
  await cascadeSettled(run.id); await laneSettled();
});
afterEach(async () => { await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string> = {}, method = "GET", body?: unknown) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const route = {
  recipes: () => import("@/app/api/recipes/route"),
  recipe: () => import("@/app/api/recipes/[id]/route"),
  step: () => import("@/app/api/recipes/[id]/steps/[stepId]/route"),
  runs: () => import("@/app/api/recipes/[id]/runs/route"),
  dependencies: () => import("@/app/api/recipes/[id]/dependencies/route"),
  layout: () => import("@/app/api/recipes/[id]/layout/route"),
};
type StepWire = { id: string; reads: string[]; condition: string; conditions: string[]; inputs: { id: string; name: string }[];
  output: { id: string; name: string } | null; missingInputs: { tableName: string; message?: string; tableId: string }[];
  latestAttempt: { state: string; output?: { id: string } } | null };
type RecipeWire = { id: string; owner: { name: string; sqlName: string }; home: string; projectId: string | null; steps: StepWire[] };
const read = async (account: string) => {
  const answer = await call(account, route.recipe, `/api/recipes/${steps.recipe}`, { id: steps.recipe });
  expect(answer.status, account).toBe(200);
  const recipe = answer.body.recipe as RecipeWire;
  return { recipe, step: (key: string) => recipe.steps.find((step) => step.id === steps[key])! };
};
const outputId = (name: string) => (metadataDb().prepare("SELECT id FROM data_tables WHERE name = ? AND owner_id = 'ada'").get(name) as { id: string }).id;

describe("a reached workflow's view", () => {
  it("names its owner and SQL home, and resolves its names in that home within the reader's reach", async () => {
    const { recipe, step } = await read("bob");
    expect(recipe).toMatchObject({ owner: { name: "ada", sqlName: "ada" }, home: "ada", projectId: "P" });
    expect(step("staged")).toMatchObject({ reads: ["roads"], condition: "current", output: { id: outputId("staged"), name: "staged" } });
    // Ada's roads, never Bob's own same-named dataset.
    expect(step("staged").inputs).toEqual([{ id: tables["ada.roads"].id, name: "roads" }]);
    expect(step("staged").latestAttempt).toMatchObject({ state: "succeeded", output: { id: outputId("staged") } });
    expect(step("final")).toMatchObject({ reads: ["staged"], condition: "current", output: { name: "final" } });
    expect(step("final").inputs).toEqual([{ id: outputId("staged"), name: "staged" }]);
  });

  it("names a reference out of the reader's reach as written, with the resource diagnostic, and leaves out what would name it", async () => {
    const { step } = await read("bob");
    // The recorded edge naming Ada's parks is left out; the read names it as written.
    expect(step("copy")).toMatchObject({ reads: ["parks"], condition: "broken", inputs: [{ id: "missing:parks", name: "parks" }] });
    expect(step("copy").missingInputs).toEqual([{ tableId: "missing:parks", tableName: "parks", message: 'The dataset "parks" is not available to you.' }]);
    expect(JSON.stringify(step("copy"))).not.toContain(tables["ada.parks"].id);
    // Its owner reads the same step as she always has.
    const own = (await read("ada")).step("copy");
    expect(own).toMatchObject({ condition: "current", inputs: [{ id: tables["ada.parks"].id, name: "parks" }], missingInputs: [] });
  });

  it("leaves out an output link and its attempt's output the reader cannot follow, reading the output as missing to them", async () => {
    unfileDataset("P", outputId("park_copy"));
    const { step } = await read("bob");
    expect(step("copy")).toMatchObject({ output: null, conditions: expect.arrayContaining(["output_missing"]) });
    expect(step("copy").latestAttempt).toMatchObject({ state: "succeeded" });
    expect(step("copy").latestAttempt!.output).toBeUndefined();
    const runs = (await call("bob", route.runs, `/api/recipes/${steps.recipe}/runs`, { id: steps.recipe })).body.runs as
      { outputs: { id: string }[]; members: { stepId: string; output: unknown }[] }[];
    expect(runs).toHaveLength(1);
    expect(runs[0].outputs.map((o) => o.id).sort()).toEqual([outputId("final"), outputId("staged")].sort());
    expect(runs[0].members.find((m) => m.stepId === steps.copy)!.output).toBeNull();
    // Its owner still follows every link.
    expect((await read("ada")).step("copy").output).toEqual({ id: outputId("park_copy"), name: "park_copy" });
  });

  it("lists it, its runs, layout and datasets to everyone who reaches it and to nobody else", async () => {
    const listed = (await call("bob", route.recipes, "/api/recipes?project=P")).body.recipes as RecipeWire[];
    expect(listed.map((r) => r.id)).toEqual([steps.recipe]);
    expect((await call("bob", route.recipes, "/api/recipes?project=none")).body.recipes).toEqual([]);
    expect((await call("bob", route.layout, `/api/recipes/${steps.recipe}/layout`, { id: steps.recipe })).status).toBe(200);
    const datasets = (await call("bob", route.dependencies, `/api/recipes/${steps.recipe}/dependencies`, { id: steps.recipe })).body.datasets as
      { id: string; qualifiedName: string }[];
    expect(datasets.map((d) => d.qualifiedName)).toEqual(["ada.final", "ada.park_copy", "ada.roads", "ada.staged"]);
    expect(datasets.map((d) => d.id)).not.toContain(tables["bob.roads"].id);
    for (const [load, url, params] of [
      [route.recipe, `/api/recipes/{}`, (id: string) => ({ id })],
      [route.runs, `/api/recipes/{}/runs`, (id: string) => ({ id })],
      [route.layout, `/api/recipes/{}/layout`, (id: string) => ({ id })],
      [route.dependencies, `/api/recipes/{}/dependencies`, (id: string) => ({ id })],
    ] as const) {
      const hidden = await call("cyd", load, url.replace("{}", steps.recipe), params(steps.recipe));
      const missing = await call("cyd", load, url.replace("{}", "never-existed"), params("never-existed"));
      expect(hidden.status, url).toBe(404);
      expect(hidden.body, url).toEqual(missing.body);
    }
    expect((await call("cyd", route.recipes, "/api/recipes")).body.recipes).toEqual([]);
    const refused = await call("cyd", route.recipes, "/api/recipes?project=P");
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual((await call("cyd", route.recipes, "/api/recipes?project=never-existed")).body);
  });

  it("answers an editor's change with the view as the editor reads it", async () => {
    const renamed = await call("edd", route.recipe, `/api/recipes/${steps.recipe}`, { id: steps.recipe }, "PATCH", { name: "Edited" });
    expect(renamed.status).toBe(200);
    const recipe = renamed.body.recipe as RecipeWire;
    expect(recipe).toMatchObject({ owner: { sqlName: "ada" }, home: "ada", projectId: "P" });
    expect(recipe.steps.find((s) => s.id === steps.copy)!.missingInputs).toEqual([
      { tableId: "missing:parks", tableName: "parks", message: 'The dataset "parks" is not available to you.' },
    ]);
    const edited = await call("edd", route.step, `/api/recipes/${steps.recipe}/steps/${steps.copy}`, { id: steps.recipe, stepId: steps.copy },
      "PATCH", { parameters: { sql: "SELECT * FROM roads", name: "park_copy" } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ applied: "proposed", step: { id: steps.copy, reads: ["roads"] } });
  });
});

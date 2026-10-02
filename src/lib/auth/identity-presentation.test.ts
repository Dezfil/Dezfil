import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileRecipe } from "@/lib/metadata/projects";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { mapDependencies } from "@/lib/map-dependencies";
import { workflowDependencies } from "@/lib/recipe-dependencies";
import { cascadeSettled, startSingleRun } from "@/lib/operations/cascade";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { duplicateRecipe } from "@/lib/operations/recipe-duplicate";
import { readRecipe } from "@/lib/operations/recipe-view";
import { recipePayload } from "@/lib/operations/recipe-api";
import { materialize } from "@/lib/operations/materialize";
import { resolveInputs } from "@/lib/operations/provenance";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "./scope";

/**
 * Dependencies, provenance, duplication, run records and the workflow view,
 * presented by identity. Ada owns project P (Bob an editor, Vi a viewer), her
 * `roads` filed in it, a map M and a workflow W filed in it; W stages `roads`
 * as `staged`. Bob owns a `roads` of his own, unfiled, and `stations`, filed
 * in P. Two people's `roads` and two runners' `staged` are told apart by
 * whose they are, and nothing names what its reader does not reach.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let ids: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "identity-presentation-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["ada", "bob", "vic", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["bob", "roads"], ["bob", "stations"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"], ["vic", "viewer"]], [tables["ada.roads"].id, tables["bob.stations"].id]);
  const map = createMap(scopes.ada, "Survey", "P");
  ids = { map: map.id };
  ids.W = createRecipe(scopes.ada, "Staging").id;
  fileRecipe(ids.W, "P");
  ids.S = addStep(ids.W, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } }).id;
});
afterEach(async () => { await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function run(account: string) {
  const cascade = await startSingleRun(scopes[account], ids.W, ids.S);
  await cascadeSettled(cascade.id); await laneSettled();
  return cascade.id;
}
const staged = (owner: string) =>
  (metadataDb().prepare("SELECT id FROM data_tables WHERE owner_id = ? AND name = 'staged'").get(owner) as { id: string }).id;
const facts = (dependencies: { id: string; qualifiedName: string; owned: boolean; producer: unknown }[]) =>
  dependencies.map(({ id, qualifiedName, owned, producer }) => ({ id, qualifiedName, owned, producer }));

describe("dependencies by identity", () => {
  it("lists a map's qualified external reads resolved to identities, whose each is, and nothing unreached", async () => {
    await createLayer(scopes.ada, ids.map, { name: "Roads", sql: "SELECT r.* FROM roads r JOIN bob.stations s ON r.sentinel <> s.sentinel" });
    await createLayer(scopes.bob, ids.map, { name: "His", sql: "SELECT * FROM bob.roads" });
    expect(facts(await mapDependencies(scopes.bob, ids.map))).toEqual([
      { id: tables["ada.roads"].id, qualifiedName: "ada.roads", owned: false, producer: null },
      { id: tables["bob.roads"].id, qualifiedName: "roads", owned: true, producer: null },
      { id: tables["bob.stations"].id, qualifiedName: "stations", owned: true, producer: null },
    ]);
    // Bob's unfiled roads is beyond Ada's reach: left out, never named.
    expect(facts(await mapDependencies(scopes.ada, ids.map))).toEqual([
      { id: tables["bob.stations"].id, qualifiedName: "bob.stations", owned: false, producer: null },
      { id: tables["ada.roads"].id, qualifiedName: "roads", owned: true, producer: null },
    ]);
  });

  it("names each runner's output with its producing workflow, which only its owner may file", async () => {
    await run("ada"); await run("bob");
    const W = { id: ids.W, name: "Staging" };
    expect(facts(await workflowDependencies(scopes.bob, ids.W))).toEqual([
      { id: tables["ada.roads"].id, qualifiedName: "ada.roads", owned: false, producer: null },
      { id: staged("ada"), qualifiedName: "ada.staged", owned: false, producer: { ...W, owned: false } },
      { id: staged("bob"), qualifiedName: "staged", owned: true, producer: { ...W, owned: false } },
    ]);
    expect(facts(await workflowDependencies(scopes.ada, ids.W))).toEqual([
      { id: staged("bob"), qualifiedName: "bob.staged", owned: false, producer: { ...W, owned: true } },
      { id: tables["ada.roads"].id, qualifiedName: "roads", owned: true, producer: null },
      { id: staged("ada"), qualifiedName: "staged", owned: true, producer: { ...W, owned: true } },
    ]);
    await createLayer(scopes.bob, ids.map, { name: "Staged", sql: "SELECT * FROM bob.staged" });
    expect(facts(await mapDependencies(scopes.ada, ids.map))).toEqual([
      { id: staged("bob"), qualifiedName: "bob.staged", owned: false, producer: { ...W, owned: true } },
    ]);
  }, 60_000);
});

describe("the workflow view names the runner and the run it describes", () => {
  it("shows each reader their own output, else the owner's, and each run its runner", async () => {
    const adaRun = await run("ada");
    const node = async (account: string) => recipePayload(await readRecipe(scopes[account], ids.W)).steps[0];
    // Before Bob runs, he and the viewer read Ada's run.
    for (const account of ["bob", "vic"]) {
      expect((await node(account)).output).toMatchObject({ id: staged("ada"), name: "staged", runner: { name: "ada", sqlName: "ada" }, runId: adaRun });
    }
    const bobRun = await run("bob");
    expect((await node("bob")).output).toMatchObject({ id: staged("bob"), runner: { sqlName: "bob" }, runId: bobRun });
    expect((await node("ada")).output).toMatchObject({ id: staged("ada"), runner: { sqlName: "ada" }, runId: adaRun });
    expect((await node("vic")).output).toMatchObject({ id: staged("ada"), runner: { sqlName: "ada" } });
    // Each record in the run history says whose run it is.
    const { GET } = await import("@/app/api/recipes/[id]/runs/route");
    const response = await GET(testAccountRequest(new Request(`http://instance.test/api/recipes/${ids.W}/runs`), undefined, "vic"), { params: Promise.resolve({ id: ids.W }) });
    const runs = (await response.json() as { runs: { id: string; runner: { sqlName: string } | null }[] }).runs;
    expect(Object.fromEntries(runs.map((entry) => [entry.id, entry.runner?.sqlName]))).toEqual({ [adaRun]: "ada", [bobRun]: "bob" });
  }, 60_000);
});

describe("duplication and provenance by identity", () => {
  it("rewrites a copy's own outputs and leaves a same-named qualified dataset external", async () => {
    await run("ada");
    const B = createRecipe(scopes.bob, "Mine").id;
    addStep(B, { operation: "sql_step", parameters: { sql: "SELECT * FROM stations", name: "staged" } });
    addStep(B, { operation: "sql_step", parameters: { sql: "SELECT * FROM staged UNION ALL SELECT * FROM ada.staged", name: "both" } });
    const copy = await duplicateRecipe(scopes.bob, B);
    const sql = metadataDb().prepare("SELECT parameters FROM recipe_steps WHERE recipe_id = ? ORDER BY ordinal").all(copy.id)
      .map((row) => JSON.parse((row as { parameters: string }).parameters).sql);
    expect(sql).toEqual(["SELECT * FROM stations", "SELECT * FROM staged_copy UNION ALL SELECT * FROM ada.staged"]);
  }, 60_000);

  it("records a result's inputs by identity and resolves them so", async () => {
    const made = await materialize(scopes.bob, { name: "both_roads", sql: "SELECT * FROM ada.roads UNION ALL SELECT * FROM roads", operation: "sql_step" });
    const derived = metadataDb().prepare("SELECT source_params FROM data_tables WHERE id = ?").get(made.id) as { source_params: string };
    const recorded = (JSON.parse(derived.source_params) as { inputs: { id: string; name: string }[] }).inputs;
    expect(recorded.map((input) => input.id).sort()).toEqual([tables["ada.roads"].id, tables["bob.roads"].id].sort());
    const table = { ...made, source: "operation", sourceParams: { inputs: recorded } } as unknown as DataTable;
    expect(resolveInputs(scopes.bob, table)?.map((input) => [input.id, input.currentName, input.missing]).sort()).toEqual(
      [[tables["ada.roads"].id, "roads", false], [tables["bob.roads"].id, "roads", false]].sort(),
    );
  });
});

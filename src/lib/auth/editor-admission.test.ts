import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileMap, fileRecipe } from "@/lib/metadata/projects";
import { createMap } from "@/lib/map-service";
import { createLayer, updateLayer } from "@/lib/layer-service";
import { undoChange } from "@/lib/map-history";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { MapRecord } from "@/lib/metadata/maps";
import type { AccountScope } from "./scope";

/**
 * SQL and dataset parameters saved into someone else's map or workflow.
 *
 * Pat owns project P; Ada is its editor and owns the map M and the workflow W
 * filed in it. Bob is an editor of P. Ada files `roads` in P and keeps
 * `secret` to herself; Bob owns a `roads` of his own, unfiled, and a
 * `stations` he filed in P; Pat keeps `parks` to herself. Every row names its
 * owner.
 *
 * Someone other than the owner saves only what they could evaluate
 * themselves: every dataset named must resolve in the map's or workflow's
 * home (Ada's) within their own reach, else the save is refused naming the
 * reference as written and nothing is written. The owner's saves are as
 * they were. Undo and redo restore SQL on the same terms, whole or not at all.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let map: MapRecord;
let recipeId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "editor-admission-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["pat", "ada", "bob"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "secret"], ["bob", "roads"], ["bob", "stations"], ["pat", "parks"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("pat", "P", [["ada", "editor"], ["bob", "editor"]], [tables["ada.roads"].id, tables["bob.stations"].id]);
  map = createMap(scopes.ada, "Survey");
  fileMap(map.id, "P");
  const recipe = createRecipe(scopes.ada, "Flow");
  fileRecipe(recipe.id, "P");
  recipeId = recipe.id;
  addStep(recipeId, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } });
});
afterEach(async () => { await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string>,
  method: string, body?: unknown) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
const route = {
  layers: () => import("@/app/api/maps/[id]/layers/route"),
  layer: () => import("@/app/api/layers/[id]/route"),
  render: () => import("@/app/api/layers/[id]/render/route"),
  undo: () => import("@/app/api/maps/[id]/undo/route"),
  redo: () => import("@/app/api/maps/[id]/redo/route"),
  steps: () => import("@/app/api/recipes/[id]/steps/route"),
  step: () => import("@/app/api/recipes/[id]/steps/[stepId]/route"),
};
const db = () => metadataDb();
function snapshot() {
  return ["maps", "layers", "map_history", "recipes", "recipe_steps", "data_tables", "project_datasets"]
    .map((name) => db().prepare(`SELECT * FROM ${name} ORDER BY 1`).all());
}
const unavailable = (name: string) => ({ status: 400, body: { error: { code: "sql_error", message: `The dataset "${name}" is not available to you.` } } });
const addLayer = (account: string, sql: string) =>
  call(account, route.layers, `/api/maps/${map.id}/layers`, { id: map.id }, "POST", { name: "Layer", sql });
async function drawn(account: string, layerId: string): Promise<string[]> {
  const render = await call(account, route.render, `/api/layers/${layerId}/render`, { id: layerId }, "GET");
  const features = (render.body as { geojson: { features: { properties: { sentinel: string } }[] } }).geojson.features;
  return features.map((feature) => feature.properties.sentinel);
}
async function refused(run: () => Promise<{ status: number; body: unknown }>, name: string) {
  const before = snapshot();
  expect(await run()).toEqual(unavailable(name));
  expect(snapshot()).toEqual(before);
}

describe("a layer saved by someone other than the map's owner", () => {
  it("admits a qualified name within the editor's reach, and draws that person's dataset", async () => {
    const saved = await addLayer("bob", "SELECT * FROM ada.roads");
    expect(saved.status).toBe(201);
    expect(await drawn("ada", (saved.body as { id: string }).id)).toEqual(["ada roads"]);
  });

  it("refuses the owner's unfiled dataset by its plain name, naming it, with nothing written", async () => {
    await refused(() => addLayer("bob", "SELECT * FROM secret"), "secret");
    await refused(() => addLayer("pat", "SELECT * FROM secret"), "secret");
    await refused(() => addLayer("bob", "SELECT * FROM ada.secret"), "ada.secret");
    await refused(() => addLayer("bob", "SELECT * FROM query_table('sec' || 'ret')"), "secret");
  });

  it("reads a plain name as the home's dataset, admitted only while the editor reaches it, never the editor's own", async () => {
    const saved = await addLayer("bob", "SELECT * FROM roads");
    expect(saved.status).toBe(201);
    expect(await drawn("bob", (saved.body as { id: string }).id)).toEqual(["ada roads"]);
    unfileDataset("P", tables["ada.roads"].id);
    await refused(() => addLayer("bob", "SELECT * FROM roads"), "roads");
  });

  it("admits a dataset the editor owns and filed, and one of their own the project's owner keeps", async () => {
    expect((await addLayer("bob", "SELECT * FROM bob.stations")).status).toBe(201);
    expect((await addLayer("pat", "SELECT * FROM pat.parks")).status).toBe(201);
    // Bob's own unfiled `roads` is within his own reach, qualified.
    expect((await addLayer("bob", "SELECT * FROM bob.roads")).status).toBe(201);
  });

  it("binds another person's quoted mount name in a local spelling like its qualified name", async () => {
    for (const sql of ['SELECT * FROM main."ada.roads"', 'SELECT * FROM memory.main."ada.roads"']) {
      const saved = await addLayer("bob", sql);
      expect(saved.status, sql).toBe(201);
      expect(await drawn("ada", (saved.body as { id: string }).id), sql).toEqual(["ada roads"]);
    }
    const before = snapshot();
    expect((await addLayer("bob", 'SELECT * FROM main."ada.secret"')).status).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it("admits the engine's own relations, which name no dataset", async () => {
    expect((await addLayer("bob", "SELECT ST_Point(0, 0) AS geom FROM range(1)")).status).toBe(201);
  });

  it("refuses an edit of the layer's SQL the same way, leaving the layer as it was", async () => {
    const layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
    await refused(() => call("bob", route.layer, `/api/layers/${layer.id}`, { id: layer.id }, "PATCH", { sql: "SELECT * FROM secret" }), "secret");
    const edited = await call("bob", route.layer, `/api/layers/${layer.id}`, { id: layer.id }, "PATCH", { sql: "SELECT * FROM bob.stations" });
    expect(edited.status).toBe(200);
  });

  it("keeps the owner's own saves as they were", async () => {
    const own = await addLayer("ada", "SELECT * FROM secret");
    expect(own.status).toBe(201);
    expect(await drawn("ada", (own.body as { id: string }).id)).toEqual(["ada secret"]);
  });
});

describe("undo and redo by someone other than the map's owner", () => {
  it("refuses a replay that would restore SQL the editor cannot evaluate, whole, with nothing restored", async () => {
    const layer = await createLayer(scopes.ada, map.id, { name: "Hidden", sql: "SELECT * FROM secret" });
    await updateLayer(scopes.ada, layer.id, { sql: "SELECT * FROM roads" });
    await refused(() => call("bob", route.undo, `/api/maps/${map.id}/undo`, { id: map.id }, "POST"), "secret");
    await refused(() => call("pat", route.undo, `/api/maps/${map.id}/undo`, { id: map.id }, "POST"), "secret");
    expect((await call("ada", route.undo, `/api/maps/${map.id}/undo`, { id: map.id }, "POST")).status).toBe(200);
  });

  it("refuses a redo the same way", async () => {
    const layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" });
    await updateLayer(scopes.ada, layer.id, { sql: "SELECT * FROM secret" });
    await undoChange(scopes.ada, map.id);
    await refused(() => call("bob", route.redo, `/api/maps/${map.id}/redo`, { id: map.id }, "POST"), "secret");
  });

  it("refuses putting back a removed layer whose SQL the editor cannot evaluate", async () => {
    const layer = await createLayer(scopes.ada, map.id, { name: "Hidden", sql: "SELECT * FROM secret" });
    expect((await call("bob", route.layer, `/api/layers/${layer.id}`, { id: layer.id }, "DELETE")).status).toBe(204);
    await refused(() => call("bob", route.undo, `/api/maps/${map.id}/undo`, { id: map.id }, "POST"), "secret");
  });

  it("restores SQL the editor reaches", async () => {
    const layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM ada.roads" });
    await updateLayer(scopes.ada, layer.id, { sql: "SELECT * FROM bob.stations" });
    const undone = await call("bob", route.undo, `/api/maps/${map.id}/undo`, { id: map.id }, "POST");
    expect(undone.status).toBe(200);
    expect(db().prepare("SELECT sql FROM layers WHERE id = ?").get(layer.id)).toEqual({ sql: "SELECT * FROM ada.roads" });
  });
});

describe("a workflow step saved by someone other than the workflow's owner", () => {
  const addStepAs = (account: string, operation: string, parameters: Record<string, unknown>) =>
    call(account, route.steps, `/api/recipes/${recipeId}/steps`, { id: recipeId }, "POST", { operation, parameters });

  it("refuses SQL naming a dataset out of the editor's reach, with nothing written", async () => {
    await refused(() => addStepAs("bob", "sql_step", { sql: "SELECT * FROM secret", name: "leak" }), "secret");
    await refused(() => addStepAs("pat", "sql_step", { sql: "SELECT * FROM ada.secret", name: "leak" }), "ada.secret");
  });

  it("refuses a dataset parameter out of the editor's reach the same way", async () => {
    await refused(() => addStepAs("bob", "buffer", { input: "secret", distance: 10, unit: "m", name: "leak" }), "secret");
    expect((await addStepAs("bob", "buffer", { input: "ada.roads", distance: 10, unit: "m", name: "ring" })).status).toBe(201);
  });

  it("admits what the editor reaches, and the workflow's declared outputs before they exist", async () => {
    expect((await addStepAs("bob", "sql_step", { sql: "SELECT * FROM roads", name: "copy" })).status).toBe(201);
    expect((await addStepAs("bob", "sql_step", { sql: "SELECT * FROM staged JOIN bob.stations USING (lon)", name: "joined" })).status).toBe(201);
  });

  it("refuses an edit of a step the same way, whether it would land or wait as a proposal", async () => {
    const step = (db().prepare("SELECT id FROM recipe_steps WHERE recipe_id = ?").get(recipeId) as { id: string }).id;
    await refused(() => call("bob", route.step, `/api/recipes/${recipeId}/steps/${step}`, { id: recipeId, stepId: step }, "PATCH",
      { parameters: { sql: "SELECT * FROM secret", name: "staged" } }), "secret");
    db().prepare("UPDATE recipe_steps SET output_table_id = ?, output_table_name = 'staged' WHERE id = ?").run(tables["ada.roads"].id, step);
    await refused(() => call("bob", route.step, `/api/recipes/${recipeId}/steps/${step}`, { id: recipeId, stepId: step }, "PATCH",
      { parameters: { sql: "SELECT * FROM secret", name: "staged" } }), "secret");
  });

  it("keeps the owner's own saves as they were", async () => {
    expect((await addStepAs("ada", "sql_step", { sql: "SELECT * FROM secret", name: "own" })).status).toBe(201);
  });
});

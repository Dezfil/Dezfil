import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { fileMap, fileRecipe } from "@/lib/metadata/projects";
import { getAccount } from "@/lib/metadata/accounts";
import { createMap, updateMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { startStepRun } from "@/lib/operations/step-execution";
import { getJob } from "@/lib/metadata/jobs";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { PERMISSION_REFUSAL } from "./reach";
import type { DataTable } from "@/lib/metadata/tables";
import type { MapRecord } from "@/lib/metadata/maps";
import type { AccountScope } from "./scope";

/**
 * Sketches drawn by someone else, and what deleting a dataset may touch.
 *
 * Pat owns project P; Ada, its editor, owns the map M filed in P; Bob is an
 * editor of P and Vi a viewer; Cyd belongs to nothing. Bob owns `stations`,
 * filed in P, which Ada's map and Ada's workflow W name.
 *
 * Anyone who may change the map's content draws on it: the sketch dataset is
 * the drawer's own, filed in the map's project, and the layer names it in the
 * map's home under the drawer's SQL name. Only the drawer edits its features.
 * Removing someone else's sketch layer leaves their dataset; removing one's
 * own keeps the cascade. Deleting a dataset never changes another person's
 * map or workflow: what named it stays and fails by name.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let stations: DataTable;
let map: MapRecord;
let recipeId: string;
const point = { kind: "point", geometry: { type: "Point", coordinates: [13.4, 52.5] } };
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "sketch-sharing-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["pat", "ada", "bob", "vi", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  const file = path.join(directory, "stations.csv");
  await writeFile(file, "sentinel,lon,lat\nbob stations,1,2\n");
  stations = await ingestFile(scopes.bob, file, "stations.csv");
  shareProject("pat", "P", [["ada", "editor"], ["bob", "editor"], ["vi", "viewer"]], [stations.id]);
  map = createMap(scopes.ada, "Survey");
  fileMap(map.id, "P");
  const recipe = createRecipe(scopes.ada, "Flow");
  fileRecipe(recipe.id, "P");
  recipeId = recipe.id;
  addStep(recipeId, { operation: "sql_step", parameters: { sql: "SELECT * FROM bob.stations", name: "copy" } });
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
  sketches: () => import("@/app/api/maps/[id]/sketches/route"),
  sketch: () => import("@/app/api/sketches/[name]/route"),
  features: () => import("@/app/api/sketches/[name]/features/route"),
  layer: () => import("@/app/api/layers/[id]/route"),
  render: () => import("@/app/api/layers/[id]/render/route"),
  table: () => import("@/app/api/tables/[name]/route"),
};
const db = () => metadataDb();
const draw = (account: string) => call(account, route.sketches, `/api/maps/${map.id}/sketches`, { id: map.id }, "POST", { feature: point });
const tableRow = (id: string) => db().prepare("SELECT id, name, owner_id FROM data_tables WHERE id = ?").get(id) as { name: string; owner_id: string } | undefined;
const layerRow = (id: string) => db().prepare("SELECT id, sql FROM layers WHERE id = ?").get(id) as { sql: string } | undefined;
/** Everything of Ada's that a deletion by someone else must leave alone. */
const adasRows = () => [
  db().prepare("SELECT * FROM maps WHERE owner_id = 'ada' ORDER BY id").all(),
  db().prepare("SELECT l.* FROM layers l JOIN maps m ON m.id = l.map_id WHERE m.owner_id = 'ada' ORDER BY l.id").all(),
  db().prepare("SELECT h.* FROM map_history h JOIN maps m ON m.id = h.map_id WHERE m.owner_id = 'ada' ORDER BY h.id").all(),
  db().prepare("SELECT * FROM recipes WHERE owner_id = 'ada' ORDER BY id").all(),
  db().prepare("SELECT s.* FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id WHERE r.owner_id = 'ada' ORDER BY s.id").all(),
];
async function drawn(account: string, layerId: string) {
  return (await call(account, route.render, `/api/layers/${layerId}/render`, { id: layerId }, "GET")).body as
    { ok: boolean; error?: { message: string }; geojson?: { features: unknown[] } };
}
const forbidden = { status: 403, body: { error: { code: "forbidden", message: PERMISSION_REFUSAL } } };

describe("a sketch drawn on someone else's map", () => {
  it("is the drawer's own dataset, filed in the map's project, named by the drawer's SQL name in the map's home", async () => {
    for (const account of ["bob", "pat"]) {
      const created = await draw(account);
      expect(created.status, account).toBe(201);
      const { tableId, layerId, table } = created.body as { tableId: string; layerId: string; table: string };
      expect(tableRow(tableId)).toMatchObject({ owner_id: account, name: table });
      expect(db().prepare("SELECT project_id FROM project_datasets WHERE table_id = ?").all(tableId)).toEqual([{ project_id: "P" }]);
      expect(layerRow(layerId)!.sql).toBe(`SELECT * FROM "${account}"."${table}"`);
      // Everyone who reaches the map draws the drawer's feature.
      for (const reader of ["ada", "bob", "pat", "vi"]) expect((await drawn(reader, layerId)).geojson?.features, `${account} ${reader}`).toHaveLength(1);
    }
    // Each drawer's builder lists their own sketch on the map, and no one else's.
    for (const account of ["ada", "bob", "pat"]) {
      const listed = await call(account, route.sketches, `/api/maps/${map.id}/sketches`, { id: map.id }, "GET");
      expect((listed.body as unknown as { tableId: string }[]).map((s) => tableRow(s.tableId)!.owner_id), account)
        .toEqual(account === "ada" ? [] : [account]);
    }
  });

  it("quotes the drawer's SQL name, so one that is also a SQL keyword draws", async () => {
    testAccountScope(undefined, "order");
    expect(getAccount("order")!.sqlName).toBe("order");
    db().prepare("INSERT INTO project_people VALUES (?, ?, ?, ?)").run("P", "order", "editor", new Date().toISOString());
    const created = await draw("order");
    expect(created.status).toBe(201);
    const { table, layerId } = created.body as { table: string; layerId: string };
    for (const reader of ["ada", "order"]) expect(await drawn(reader, layerId), reader).toMatchObject({ ok: true, geojson: { features: [{}] } });
    expect(layerRow(layerId)!.sql).toBe(`SELECT * FROM "order"."${table}"`);
  });

  it("is refused to a viewer by the permission shape and to an outsider as absent", async () => {
    expect(await draw("vi")).toEqual(forbidden);
    expect((await draw("cyd")).status).toBe(404);
    expect(db().prepare("SELECT count(*) AS n FROM data_tables WHERE source = 'sketch'").get()).toEqual({ n: 0 });
  });

  it("has its features edited by its drawer only, whatever the map's role grants", async () => {
    const { table } = (await draw("bob")).body as { table: string };
    expect((await call("bob", route.features, `/api/sketches/${table}/features`, { name: table }, "POST", { feature: point })).status).toBe(201);
    for (const account of ["ada", "pat"]) {
      const address = `bob.${table}`;
      expect(await call(account, route.features, `/api/sketches/${address}/features`, { name: address }, "POST", { feature: point }), account)
        .toEqual(forbidden);
      expect(await call(account, route.sketch, `/api/sketches/${address}`, { name: address }, "DELETE"), account).toEqual(forbidden);
      // Its features are read by whoever reaches it.
      const read = await call(account, route.features, `/api/sketches/${address}/features`, { name: address }, "GET");
      expect((read.body as { features: unknown[] }).features, account).toHaveLength(2);
    }
  });

  it("leaves the drawer's dataset when someone else removes its layer, and goes with it when the drawer does", async () => {
    const first = (await draw("bob")).body as { tableId: string; layerId: string };
    expect((await call("ada", route.layer, `/api/layers/${first.layerId}`, { id: first.layerId }, "DELETE")).status).toBe(200);
    expect(layerRow(first.layerId)).toBeUndefined();
    expect(tableRow(first.tableId)).toMatchObject({ owner_id: "bob" });
    // Its drawer can still delete it, the map untouched.
    const before = adasRows();
    const name = tableRow(first.tableId)!.name;
    expect((await call("bob", route.sketch, `/api/sketches/${name}`, { name }, "DELETE")).status).toBe(200);
    expect(tableRow(first.tableId)).toBeUndefined();
    expect(adasRows()).toEqual(before);
    const second = (await draw("bob")).body as { tableId: string; layerId: string };
    expect((await call("bob", route.layer, `/api/layers/${second.layerId}`, { id: second.layerId }, "DELETE")).status).toBe(200);
    expect(layerRow(second.layerId)).toBeUndefined();
    expect(tableRow(second.tableId)).toBeUndefined();
  });

  it("is deleted by its drawer without touching the map it was drawn on, whose layer then fails by name", async () => {
    const { table, tableId, layerId } = (await draw("bob")).body as { table: string; tableId: string; layerId: string };
    updateMap(scopes.ada, map.id, { widgets: [{ id: "count", type: "formula", layerId, title: "Count", field: null,
      agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }] });
    const before = adasRows();
    expect((await call("bob", route.sketch, `/api/sketches/${table}`, { name: table }, "DELETE")).status).toBe(200);
    expect(tableRow(tableId)).toBeUndefined();
    expect(adasRows()).toEqual(before);
    expect(await drawn("ada", layerId)).toMatchObject({ ok: false, error: { message: `The dataset "bob.${table}" is not available to you.` } });
  });

  it("keeps the whole cascade on the drawer's own map", async () => {
    const own = createMap(scopes.ada, "Own");
    const created = await call("ada", route.sketches, `/api/maps/${own.id}/sketches`, { id: own.id }, "POST", { feature: point });
    const { table, tableId, layerId } = created.body as { table: string; tableId: string; layerId: string };
    expect(layerRow(layerId)!.sql).toBe(`SELECT * FROM ${table}`);
    expect((await call("ada", route.sketch, `/api/sketches/${table}`, { name: table }, "DELETE")).status).toBe(200);
    expect(tableRow(tableId)).toBeUndefined();
    expect(layerRow(layerId)).toBeUndefined();
  });
});

describe("deleting a dataset someone else's map and workflow name", () => {
  it("changes nothing of theirs: the layer and the step stay, and fail by name", async () => {
    const layer = await createLayer(scopes.ada, map.id, { name: "Stations", sql: "SELECT * FROM bob.stations" });
    updateMap(scopes.ada, map.id, { widgets: [{ id: "count", type: "formula", layerId: layer.id, title: "Count", field: null,
      agg: "count", aggField: null, unit: null, note: null, format: null, visible: true }] });
    const bobsMap = createMap(scopes.bob, "Mine");
    const bobsLayer = await createLayer(scopes.bob, bobsMap.id, { name: "Stations", sql: "SELECT * FROM stations" });
    const before = adasRows();
    expect((await call("bob", route.table, "/api/tables/stations", { name: "stations" }, "DELETE")).status).toBe(204);
    expect(tableRow(stations.id)).toBeUndefined();
    expect(adasRows()).toEqual(before);
    expect(layerRow(bobsLayer.id)).toBeDefined();
    expect(await drawn("ada", layer.id)).toMatchObject({ ok: false, error: { message: 'The dataset "bob.stations" is not available to you.' } });
    // The workflow's step reading it fails by name when it runs.
    const step = db().prepare("SELECT id FROM recipe_steps WHERE recipe_id = ?").get(recipeId) as { id: string };
    const job = await startStepRun(scopes.ada, step.id);
    await laneSettled();
    expect(getJob(job.id)).toMatchObject({ state: "failed", errorCode: "sql_error", errorMessage: 'The dataset "bob.stations" is not available to you.' });
  });
});

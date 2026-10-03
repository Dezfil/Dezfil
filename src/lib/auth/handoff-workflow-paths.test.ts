import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
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
import { cascadeSettled, startSingleRun } from "@/lib/operations/cascade";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { executeQuery } from "@/lib/query/execute";
import { contextOf, workflowEvaluation } from "@/lib/query/context";
import { testAccountRequest, testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import type { DataTable } from "@/lib/metadata/tables";
import type { AccountScope } from "./scope";

/**
 * Definitions that move into a workflow keep the datasets they named.
 *
 * Ada owns project P, her `roads` filed in it, a map M whose layer draws
 * `roads`, and three workflows filed in P: W1 stages her roads as `staged`
 * and has a node reading `staged` beside `roads`; W2 declares an output
 * called `roads` of its own; W3 is empty. Bob, an editor of P, owns a
 * `roads` of his own and a workflow B. Cyd reaches nothing. Every row names
 * its owner as a sentinel.
 *
 * A captured layer, a node pasted from another workflow, console SQL and a
 * result saved as a dataset are each carried into where they land: a home
 * dataset is qualified where the destination's home is someone else's or an
 * output there takes the name, and a departing workflow output becomes the
 * dataset the acting person's own run made.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let ids: Record<string, string>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "handoff-workflow-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["bob", "roads"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"]], [tables["ada.roads"].id]);
  const map = createMap(scopes.ada, "Survey", "P");
  const layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  ids = { map: map.id, layer: layer.id };
  for (const name of ["W1", "W2", "W3"]) {
    ids[name] = createRecipe(scopes.ada, name).id;
    fileRecipe(ids[name], "P");
  }
  ids.B = createRecipe(scopes.bob, "B").id;
  ids.staged = addStep(ids.W1, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } }).id;
  ids.reader = addStep(ids.W1, { operation: "sql_step", parameters: { sql: "SELECT * FROM staged UNION ALL SELECT * FROM roads", name: "twice" } }).id;
  addStep(ids.W2, { operation: "sql_step", parameters: { sql: "SELECT 1 AS x", name: "roads" } });
});
afterEach(async () => { await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(account: string, load: () => Promise<Record<string, unknown>>, url: string, params: Record<string, string>, method: string, body: unknown, basis?: string | null) {
  const request = testAccountRequest(new Request(`http://instance.test${url}`, {
    method, headers: { "content-type": "application/json", ...(basis ? { "X-Edit-Revision": basis } : {}) }, body: JSON.stringify(body),
  }), undefined, account);
  const response = await ((await load())[method] as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
const stepsRoute = () => import("@/app/api/recipes/[id]/steps/route");
const stepRoute = () => import("@/app/api/recipes/[id]/steps/[stepId]/route");
const runRoute = () => import("@/app/api/operations/run/route");
const addTo = (account: string, recipe: string, body: Record<string, unknown>) =>
  call(account, stepsRoute, `/api/recipes/${recipe}/steps`, { id: recipe }, "POST", body, readEditRevision({ kind: "workflow", id: recipe })?.editRevision);
const storedSql = (body: Record<string, unknown> | null) =>
  ((body?.step as { parameters: { sql: string } }).parameters.sql);
const stepCount = (recipe: string) =>
  (metadataDb().prepare("SELECT COUNT(*) AS n FROM recipe_steps WHERE recipe_id = ?").get(recipe) as { n: number }).n;
const sentinels = async (scope: Parameters<typeof executeQuery>[0], sql: string) =>
  (await executeQuery(scope, sql)).preview.map((row) => row.sentinel);

describe("a layer captured into a workflow", () => {
  it("carries the layer's references into the capturing person's own workflow", async () => {
    const added = await addTo("bob", ids.B, { operation: "sql_step", fromLayerId: ids.layer, parameters: { name: "from_map" } });
    expect(added.status).toBe(201);
    expect(storedSql(added.body)).toBe("SELECT * FROM ada.roads");
    expect((added.body?.step as { origin: { layerId: string } }).origin.layerId).toBe(ids.layer);
    expect(await sentinels(workflowEvaluation(scopes.bob, ids.B), storedSql(added.body))).toEqual(["ada roads"]);
  });

  it("keeps a home dataset external against a same-named output of the workflow it lands in", async () => {
    const added = await addTo("ada", ids.W2, { operation: "sql_step", fromLayerId: ids.layer, parameters: { name: "copied" } });
    expect(added.status).toBe(201);
    expect(storedSql(added.body)).toBe("SELECT * FROM ada.roads");
  });

  it("answers a layer the capturer does not reach exactly as a missing one, writing nothing", async () => {
    const own = createRecipe(scopes.cyd, "C").id;
    const hidden = await addTo("cyd", own, { operation: "sql_step", fromLayerId: ids.layer, parameters: { name: "x" } });
    const never = await addTo("cyd", own, { operation: "sql_step", fromLayerId: "never-existed", parameters: { name: "x" } });
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(never);
    expect(stepCount(own)).toBe(0);
  });
});

describe("a node moved between workflows", () => {
  it("carries a departing output as the mover's own dataset and the source home's datasets qualified", async () => {
    const run = await startSingleRun(scopes.bob, ids.W1, ids.staged, { expectedRevision: readEditRevision({ kind: "workflow", id: ids.W1 })?.editRevision });
    await cascadeSettled(run.id); await laneSettled();
    const values = { sql: "SELECT * FROM staged UNION ALL SELECT * FROM roads", name: "pasted" };
    const added = await addTo("bob", ids.B, { operation: "sql_step", parameters: values, writtenIn: { kind: "workflow", id: ids.W1 } });
    expect(added.status).toBe(201);
    // Bob's own staging is his plain `staged` in his home; Ada's roads is hers.
    expect(storedSql(added.body)).toBe("SELECT * FROM staged UNION ALL SELECT * FROM ada.roads");
    const into = await addTo("bob", ids.W3, { operation: "sql_step", parameters: { ...values, name: "pasted_too" }, writtenIn: { kind: "workflow", id: ids.W1 } });
    expect(storedSql(into.body)).toBe("SELECT * FROM bob.staged UNION ALL SELECT * FROM roads");
  }, 60_000);

  it("refuses a departing output the mover has not produced, writing nothing", async () => {
    const values = { sql: "SELECT * FROM staged", name: "pasted" };
    const refused = await addTo("ada", ids.W3, { operation: "sql_step", parameters: values, writtenIn: { kind: "workflow", id: ids.W1 } });
    expect(refused).toEqual({ status: 400, body: { error: { code: "sql_error",
      message: 'The dataset "staged" is a workflow output you have not produced yet, so it cannot be carried over.' } } });
    expect(stepCount(ids.W3)).toBe(0);
  });

  it("keeps a home dataset external when it moves into a workflow of the same home whose output takes its name", async () => {
    const added = await addTo("ada", ids.W2, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "moved" },
      writtenIn: { kind: "workflow", id: ids.W1 } });
    expect(storedSql(added.body)).toBe("SELECT * FROM ada.roads");
    // Written in that workflow itself, nothing moves.
    const here = await addTo("ada", ids.W1, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "same" },
      writtenIn: { kind: "workflow", id: ids.W1 } });
    expect(storedSql(here.body)).toBe("SELECT * FROM roads");
  });

  it("carries a named input and an edit's parameters the same way", async () => {
    const added = await addTo("bob", ids.W3, { operation: "buffer", parameters: { input: "roads", distance: 10, name: "buffered" },
      writtenIn: { kind: "console" } });
    expect(added.status).toBe(201);
    expect((added.body?.step as { parameters: { input: string } }).parameters.input).toBe("bob.roads");
    const stepId = (added.body?.step as { id: string }).id;
    const edited = await call("bob", stepRoute, `/api/recipes/${ids.W3}/steps/${stepId}`, { id: ids.W3, stepId }, "PATCH",
      { parameters: { input: "roads", distance: 20, name: "buffered" }, writtenIn: { kind: "console" } }, readEditRevision({ kind: "workflow", id: ids.W3 })?.editRevision);
    expect(edited.status).toBe(200);
    expect((edited.body?.step as { parameters: { input: string; distance: number } }).parameters).toMatchObject({ input: "bob.roads", distance: 20 });
  });
});

describe("a result saved as a dataset", () => {
  const save = (account: string, body: Record<string, unknown>) => call(account, runRoute, "/api/operations/run", {}, "POST", body);

  it("runs the SQL in the context it was previewed in and lands as the saver's own dataset", async () => {
    const sql = "SELECT * FROM roads";
    const fromMap = await save("bob", { operation: "sql_step", parameters: { sql, name: "seen_on_map" }, writtenIn: { kind: "map", id: ids.map } });
    const fromConsole = await save("bob", { operation: "sql_step", parameters: { sql, name: "seen_in_console" } });
    expect([fromMap.status, fromConsole.status]).toEqual([202, 202]);
    await laneSettled();
    const owner = (name: string) => (metadataDb().prepare("SELECT owner_id AS owner FROM data_tables WHERE name = ?").all(name) as { owner: string }[]);
    expect(owner("seen_on_map")).toEqual([{ owner: "bob" }]);
    expect(await sentinels(contextOf(scopes.bob), "SELECT sentinel FROM seen_on_map")).toEqual(["ada roads"]);
    expect(await sentinels(contextOf(scopes.bob), "SELECT sentinel FROM seen_in_console")).toEqual(["bob roads"]);
  }, 60_000);

  it("previews it there too, and refuses a context the caller does not reach as a missing one", async () => {
    const dry = async (account: string, writtenIn?: unknown) => save(account, {
      operation: "sql_step", dryRun: true, parameters: { sql: "SELECT * FROM roads WHERE sentinel = 'ada roads'" }, ...(writtenIn ? { writtenIn } : {}),
    });
    expect(((await dry("bob", { kind: "map", id: ids.map })).body?.dryRun as { rowCount: number }).rowCount).toBe(1);
    expect(((await dry("bob")).body?.dryRun as { rowCount: number }).rowCount).toBe(0);
    const hidden = await dry("cyd", { kind: "map", id: ids.map });
    const never = await dry("cyd", { kind: "map", id: "never-existed" });
    expect(hidden.status).toBe(404);
    expect(hidden).toEqual(never);
  });
});

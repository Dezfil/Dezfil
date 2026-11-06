import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import { ingestFile } from "@/lib/ingest/ingest";
import type { AccountScope } from "@/lib/auth/scope";
import { createMap } from "@/lib/map-service";
import { insertLayer, insertMap } from "@/lib/metadata/maps";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { normalizeStyle } from "@/lib/style/style";
import { removeTable } from "@/lib/table-service";
import { readTableReaders } from "./table-readers";

/**
 * What reads a table, against answers written out by hand. Ada owns
 * `roads`; Bob is an Editor of her project P, which holds it, and owns a
 * `roads` of his own; Cyd is outside. The fixture puts every reader the
 * delete dialog must name beside every near miss it must not: a longer
 * name, a comment, a string, a CTE, an alias, another owner's table, a
 * builder record, and a declared workflow output.
 */

const hold = vi.hoisted(() => ({ beforeAnalysis: undefined as undefined | (() => void) }));
vi.mock("@/lib/query/bounded", async (original) => {
  const real = await original<typeof import("@/lib/query/bounded")>();
  return {
    ...real,
    boundedEvaluation: (...args: Parameters<typeof real.boundedEvaluation>) => {
      hold.beforeAnalysis?.();
      return real.boundedEvaluation(...args);
    },
  };
});

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, string>;
let ordinal = 0;

async function ingest(owner: string, name: string): Promise<string> {
  const file = path.join(directory, `${owner}-${name}.csv`);
  await writeFile(file, "id,lon,lat\n1,1,2\n2,3,4\n3,5,6\n");
  await ingestFile(scopes[owner], file, `${name}.csv`);
  const row = metadataDb().prepare("SELECT id FROM data_tables WHERE owner_id = ? AND name = ?").get(owner, name) as { id: string };
  return row.id;
}

function map(owner: string, name: string, layers: [name: string, sql: string, visible?: boolean][], projectId: string | null = null): string {
  const id = createMap(scopes[owner], name, projectId).id;
  for (const [layer, sql, visible = true] of layers) {
    insertLayer({ id: `${name}/${layer}`, mapId: id, name: layer, sql, style: normalizeStyle({}), visible, tooltip: null, popup: null,
      publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null,
      ordinal: ordinal++, createdAt: "time", updatedAt: "time" });
  }
  return id;
}

function workflow(owner: string, name: string, steps: { operation?: string; parameters: Record<string, unknown>; proposed?: Record<string, unknown> }[], origin: "workflow" | "builder" = "workflow"): { id: string; steps: string[] } {
  const recipe = createRecipe(scopes[owner], name, metadataDb(), origin);
  const ids = steps.map((step) => {
    const added = addStep(recipe.id, { operation: step.operation ?? "sql_step", parameters: step.parameters });
    if (step.proposed) metadataDb().prepare("UPDATE recipe_steps SET proposed_parameters = ? WHERE id = ?").run(JSON.stringify(step.proposed), added.id);
    return added.id;
  });
  return { id: recipe.id, steps: ids };
}

function publish(mapId: string) {
  metadataDb().prepare("UPDATE maps SET publish_token = ?, published_at = ? WHERE id = ?").run(`token-${mapId}`, "time", mapId);
}

const layer = (mapName: string, mapId: string, name: string, published = false) =>
  ({ kind: "layer", map: { id: mapId, name: mapName, published }, layer: { id: `${mapName}/${name}`, name } });
const step = (workflowName: string, workflowId: string, stepId: string, position: number) =>
  ({ kind: "step", workflow: { id: workflowId, name: workflowName }, step: { id: stepId, position, operation: "sql_step", label: "SQL step" } });

beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "table-readers-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  hold.beforeAnalysis = undefined;
  scopes = Object.fromEntries(["ada", "bob", "cyd", "adm"].map((id) => [id, testAccountScope(undefined, id)]));
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'adm'").run();
  tables = {
    roads: await ingest("ada", "roads"),
    mainRoads: await ingest("ada", "main_roads"),
    bobRoads: await ingest("bob", "roads"),
  };
  shareProject("ada", "P", [["bob", "editor"]], [tables.roads]);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("what reads a table", () => {
  it("names each reader the owner can open, counts the rest, and nothing else", async () => {
    const alpha = map("ada", "Alpha", [["One", "SELECT * FROM roads"], ["Two", "SELECT count(*) FROM roads a JOIN roads b ON true"], ["Longer", "SELECT * FROM main_roads"]]);
    publish(alpha);
    const beta = map("ada", "Beta", [["Hidden", "SELECT * FROM query_table('ro' || 'ads')", false]]);
    map("ada", "Gamma", [
      ["Comment", "-- roads\nSELECT 1"],
      ["String", "SELECT 'roads' AS x"],
      ["Cte", "WITH roads AS (SELECT 1 AS x) SELECT * FROM roads"],
      ["Alias", "SELECT roads.id FROM main_roads AS roads"],
    ]);
    const delta = map("ada", "Delta", [["Nested", "SELECT * FROM query('SELECT * FROM \"Roads\"')"], ["Qualified", "SELECT * FROM ada.roads"]]);
    map("bob", "Bob plain", [["Own", "SELECT * FROM roads"]]);
    const shared = map("bob", "Bob shared", [["Hers", "SELECT * FROM ada.roads"]], "P");
    map("bob", "Bob private", [["Hers", "SELECT * FROM ada.roads"]]);
    // Cyd's copy of a map from Ada's space keeps Ada's home: its plain
    // names still mean Ada's tables.
    const source = createMap(scopes.ada, "Source");
    insertMap(scopes.cyd, { ...source, id: "moved", name: "Moved" }, metadataDb(), "ada");
    metadataDb().prepare("DELETE FROM maps WHERE id = ?").run(source.id);
    insertLayer({ id: "Moved/Plain", mapId: "moved", name: "Plain", sql: "SELECT * FROM roads", style: normalizeStyle({}), visible: true, tooltip: null,
      popup: null, publishedFields: null, inLegend: true, viz: { type: "points" }, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null,
      ordinal: ordinal++, createdAt: "time", updatedAt: "time" });
    const flow = workflow("ada", "Flow", [
      { parameters: { sql: "SELECT * FROM roads", name: "derived" } },
      { parameters: { sql: "SELECT * FROM derived", name: "again" } },
    ]);
    const pending = workflow("ada", "Pending", [
      { parameters: { sql: "SELECT 1 AS x", name: "first" }, proposed: { sql: "SELECT * FROM roads", name: "first" } },
      { parameters: { sql: "SELECT * FROM roads", name: "second" }, proposed: { sql: "SELECT 1 AS x", name: "second" } },
    ]);
    const verb = workflow("ada", "Verb", [{ operation: "buffer", parameters: { input: "roads", distance: 10, name: "buffered" } }]);
    workflow("ada", "Builder", [{ parameters: { sql: "SELECT * FROM roads", name: "tool" } }], "builder");

    const answer = await readTableReaders(scopes.ada, "roads");
    expect(answer).toEqual({
      table: { id: tables.roads, name: "roads", rowCount: 3 },
      readers: [
        layer("Alpha", alpha, "One", true),
        layer("Alpha", alpha, "Two", true),
        layer("Beta", beta, "Hidden"),
        { ...layer("Bob shared", shared, "Hers") },
        layer("Delta", delta, "Nested"),
        layer("Delta", delta, "Qualified"),
        step("Flow", flow.id, flow.steps[0], 1),
        step("Pending", pending.id, pending.steps[0], 1),
        { kind: "step", workflow: { id: verb.id, name: "Verb" }, step: { id: verb.steps[0], position: 1, operation: "buffer", label: expect.any(String) } },
      ],
      unlisted: 2,
    });
    expect(JSON.stringify(answer)).not.toMatch(/Bob private|Moved|cyd/);
  });

  it("answers the same table by its identifier, and an empty answer for a table nothing reads", async () => {
    map("ada", "Alpha", [["One", "SELECT * FROM roads"]]);
    expect((await readTableReaders(scopes.ada, tables.roads)).readers).toHaveLength(1);
    expect(await readTableReaders(scopes.ada, "main_roads")).toEqual({ table: { id: tables.mainRoads, name: "main_roads", rowCount: 3 }, readers: [], unlisted: 0 });
  });

  it("counts a reader alone when the owner can open none of them", async () => {
    map("bob", "Bob private", [["Hers", "SELECT * FROM ada.roads"], ["Again", "SELECT * FROM ada.roads"]]);
    expect(await readTableReaders(scopes.ada, "roads")).toEqual({ table: { id: tables.roads, name: "roads", rowCount: 3 }, readers: [], unlisted: 2 });
  });

  it("never reads the engine's own catalogue as a home table", async () => {
    const own = await ingest("ada", "tables");
    expect((metadataDb().prepare("SELECT name FROM data_tables WHERE id = ?").get(own) as { name: string }).name).toBe("tables");
    map("ada", "Catalogue", [["Engine", "SELECT * FROM information_schema.tables"]]);
    const answer = await readTableReaders(scopes.ada, own);
    expect(answer.readers).toEqual([]);
    expect(answer.unlisted).toBe(0);
  });

  it("binds a declared output only to the owner's own run of it", async () => {
    const made = await ingest("ada", "made");
    const bobMade = await ingest("bob", "made");
    const runs = workflow("ada", "Runs", [
      { parameters: { sql: "SELECT 1 AS x", name: "made" }, proposed: { sql: "SELECT 1 AS x", name: "made_two" } },
      { parameters: { sql: "SELECT * FROM made", name: "after" } },
    ]);
    const record = metadataDb().prepare(`INSERT INTO step_runner_outputs (step_id, runner_id, output_table_id, output_table_name, run_id, succeeded_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    record.run(runs.steps[0], "bob", bobMade, "made", "run-bob", "time");
    // Only Bob has run it: Ada's `made` is not the declared output's, and a
    // declared output never falls back to a same-named home table.
    expect((await readTableReaders(scopes.ada, made)).readers).toEqual([]);
    record.run(runs.steps[0], "ada", made, "made", "run-ada", "time");
    // Ada's own run made it: the step reading the output reads it; the
    // step that produced it does not.
    expect((await readTableReaders(scopes.ada, made)).readers).toEqual([step("Runs", runs.id, runs.steps[1], 2)]);
  });

  it("decides what to name after the analysis, so access lost meanwhile is counted, not named", async () => {
    const shared = map("bob", "Bob shared", [["Hers", "SELECT * FROM ada.roads"]], "P");
    hold.beforeAnalysis = () => { metadataDb().prepare("UPDATE maps SET project_id = NULL WHERE id = ?").run(shared); };
    const answer = await readTableReaders(scopes.ada, "roads");
    expect(answer).toEqual({ table: { id: tables.roads, name: "roads", rowCount: 3 }, readers: [], unlisted: 1 });
  });

  it("fails the whole read when a query cannot be analyzed, naming the map only to someone who can open it", async () => {
    map("bob", "Bob private", [["Broken", "SELEC * FRM roads"]]);
    const hidden = readTableReaders(scopes.ada, "roads");
    await expect(hidden).rejects.toMatchObject({ code: "dependencies_unresolved", status: 422 });
    await expect(readTableReaders(scopes.ada, "roads")).rejects.toThrow(/in a map or workflow could not/);
    await expect(readTableReaders(scopes.ada, "roads")).rejects.not.toThrow(/Bob/);
    metadataDb().prepare("DELETE FROM maps WHERE name = 'Bob private'").run();
    map("ada", "Mine", [["Broken", "SELEC * FRM roads"]]);
    await expect(readTableReaders(scopes.ada, "roads")).rejects.toThrow(/the map "Mine" could not/);
  });

  it("answers the owner alone, and refuses everyone else as a delete would", async () => {
    await expect(readTableReaders(scopes.bob, "ada.roads")).rejects.toMatchObject({ status: 403 });
    await expect(readTableReaders(scopes.bob, tables.roads)).rejects.toMatchObject({ status: 403 });
    shareProject("ada", "Q", [["cyd", "viewer"], ["adm", "viewer"]], [tables.mainRoads]);
    await expect(readTableReaders(scopes.cyd, "ada.main_roads")).rejects.toMatchObject({ status: 403 });
    await expect(readTableReaders(scopes.adm, "ada.main_roads")).rejects.toMatchObject({ status: 403 });
    // The owner of a project Ada's table is filed in is not its owner either.
    shareProject("cyd", "R", [["ada", "editor"]], [tables.roads]);
    await expect(readTableReaders(scopes.cyd, "ada.roads")).rejects.toMatchObject({ status: 403 });
    await expect(readTableReaders(scopes.cyd, tables.roads)).rejects.toMatchObject({ status: 403 });
    unfileDataset("R", tables.roads);
    const absent = await readTableReaders(scopes.cyd, "ada.roads").catch((error) => error);
    const missing = await readTableReaders(scopes.cyd, "ada.nothing").catch((error) => error);
    expect(absent.status).toBe(404);
    expect({ code: absent.code, status: absent.status, message: absent.message }).toEqual({ code: missing.code, status: missing.status, message: missing.message });
  });

  it("answers absent once the table is gone, and deleting keeps everything that read it", async () => {
    const alpha = map("ada", "Alpha", [["One", "SELECT * FROM roads"]]);
    await removeTable(scopes.ada, tables.roads);
    await expect(readTableReaders(scopes.ada, tables.roads)).rejects.toMatchObject({ status: 404 });
    expect(metadataDb().prepare("SELECT id FROM maps WHERE id = ?").get(alpha)).toBeTruthy();
    expect(metadataDb().prepare("SELECT id FROM data_tables WHERE id = ?").get(tables.bobRoads)).toBeTruthy();
    expect(metadataDb().prepare("SELECT 1 FROM project_datasets WHERE table_id = ?").get(tables.roads)).toBeUndefined();
  });
});

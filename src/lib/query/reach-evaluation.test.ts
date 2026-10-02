import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { createMap } from "@/lib/map-service";
import { createLayer, renderLayer, baseFields, layerFieldStats } from "@/lib/layer-service";
import { layerExtent } from "@/lib/extent-service";
import { computeWidgetValues } from "@/lib/widget-service";
import { exportLayerResult } from "@/lib/export/layer-export";
import { classifyFill } from "@/lib/style/classify";
import { exportGeoJsonSeq } from "@/lib/tiles/export";
import { ensureTileDirs, tileScratchDir } from "@/lib/tiles/paths";
import { materialize } from "@/lib/operations/materialize";
import { startStepRun } from "@/lib/operations/step-execution";
import { laneSettled, resetLane } from "@/lib/operations/lane";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import { getJob } from "@/lib/metadata/jobs";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import type { Layer, MapRecord } from "@/lib/metadata/maps";
import { executeQuery } from "./execute";
import { boundedEvaluation } from "./bounded";
import { namedSql } from "./named-sql";
import { layerEvaluation, mapEvaluation, workflowEvaluation } from "./context";
import type { DatasetScope } from "./access";

/**
 * Evaluation under reach, end to end. Ada owns `roads` (filed in her
 * project, where Bob is an editor) and `parks` (unfiled); Bob and Cyd each
 * own a `roads`; Cyd belongs to nothing. Every dataset's one row names its
 * owner.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
let map: MapRecord;
let layer: Layer;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "reach-evaluation-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance(); resetLane();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"], ["cyd", "roads"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"]], [tables["ada.roads"].id]);
  map = createMap(scopes.ada, "Survey");
  layer = await createLayer(scopes.ada, map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
});
afterEach(async () => { await laneSettled(); resetLane(); closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

const failure = async (run: () => Promise<unknown>) => {
  const outcome = await run().then(() => null, (error: unknown) => error);
  expect(outcome, "expected a refusal").not.toBeNull();
  const error = outcome as { code: string; message: string; status: number };
  return { code: error.code, message: error.message, status: error.status };
};

/** Every resource evaluation of one layer SQL, by one caller, in Ada's map:
 * the message each surfaces where its failure is shown. */
async function resourceFailures(scope: AccountScope, sql: string): Promise<Record<string, string>> {
  const saved = { ...layer, sql };
  const widgets = [{ id: "count", type: "formula" as const, layerId: layer.id, title: "Count", field: null, agg: "count" as const, aggField: null, unit: null, note: null, format: null, visible: true }];
  const render = await renderLayer(scope, saved);
  const widget = (await computeWidgetValues(scope, { ...map, widgets }, [saved], [])).widgets[0] as { error?: string };
  ensureTileDirs();
  const recipe = createRecipe(scopes.ada, `Step ${Math.random()}`);
  return {
    render: render.ok ? "rendered" : render.error!.message,
    fields: (await failure(() => baseFields(scope, saved))).message,
    stats: (await failure(() => layerFieldStats(scope, saved, "sentinel"))).message,
    extent: (await failure(() => layerExtent(scope, saved))).message,
    widget: widget.error ?? "computed",
    export: (await failure(() => exportLayerResult(scope, saved, "csv"))).message,
    classification: (await failure(() => classifyFill(layerEvaluation(scope, saved), sql, "sentinel", "categorical"))).message,
    tiles: (await failure(() => exportGeoJsonSeq(mapEvaluation(scope, map.id), { sql, filters: [], geometryColumn: "geometry", columns: ["sentinel"] }, path.join(tileScratchDir(), `t-${Math.random()}.geojsonseq`)))).message,
    step: (await failure(() => materialize(scope, { name: `out_${Math.random().toString(36).slice(2)}`, sql, operation: "sql_step", evaluation: workflowEvaluation(scope, recipe.id) }))).message,
  };
}
const everywhere = (message: string) => Object.fromEntries(["render", "fields", "stats", "extent", "widget", "export", "classification", "tiles", "step"].map((key) => [key, message]));

describe("the resource diagnostic", () => {
  it("names a reference the caller cannot reach in every resource evaluation, the same for a hidden and a nonexistent one", async () => {
    const hidden = await resourceFailures(scopes.bob, "SELECT * FROM parks");
    const missing = await resourceFailures(scopes.bob, "SELECT * FROM nothing");
    expect(hidden).toEqual(everywhere('The dataset "parks" is not available to you.'));
    expect(missing).toEqual(everywhere('The dataset "nothing" is not available to you.'));
    expect(await resourceFailures(scopes.bob, "SELECT * FROM cyd.roads")).toEqual(everywhere('The dataset "cyd.roads" is not available to you.'));
    expect(await resourceFailures(scopes.bob, "SELECT * FROM query_table('cyd.' || 'roads')")).toEqual(everywhere('The dataset "cyd.roads" is not available to you.'));
    expect(await resourceFailures(scopes.cyd, "SELECT * FROM roads")).toEqual(everywhere('The dataset "roads" is not available to you.'));
    // A name that reads like a file word is still repeated as written.
    expect(await resourceFailures(scopes.bob, "SELECT * FROM cyd.parquet")).toEqual(everywhere('The dataset "cyd.parquet" is not available to you.'));
    // Nothing about the name's owner, location or existence travels.
    for (const message of [...Object.values(hidden), ...Object.values(missing)]) expect(message).not.toMatch(/ada|project|exist|unknown|parquet|tables\//i);
  });

  it("keeps the home's own refusal for a name it does not hold, and names a qualified reference outside its reach", async () => {
    const render = async (sql: string) => renderLayer(scopes.ada, { ...layer, sql });
    expect(await render("SELECT * FROM parks")).toMatchObject({ ok: true });
    expect(await render("SELECT * FROM nothing")).toMatchObject({ ok: false, error: { code: "sql_error", message: "The query refers to an unknown table." } });
    expect(await render("SELECT * FROM cyd.roads")).toMatchObject({ ok: false, error: { code: "sql_error", message: 'The dataset "cyd.roads" is not available to you.' } });
    expect(await renderLayer(scopes.bob, layer)).toMatchObject({ ok: true, geojson: { features: [{ properties: { sentinel: "ada roads" } }] } });
  });

  it("names a declared output its runner has not produced, as the failure of the step that reads it", async () => {
    const recipe = createRecipe(scopes.ada, "Stages");
    addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "staged" } });
    const reader = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM staged", name: "final" } });
    const job = await startStepRun(scopes.ada, reader.id);
    await laneSettled();
    expect(getJob(job.id)).toMatchObject({ state: "failed", errorCode: "sql_error", errorMessage: 'The dataset "staged" is not available to you.' });
  });
});

describe("the console under reach", () => {
  it("reads exactly the caller's reach by name, and refuses the rest with the generic refusal", async () => {
    expect((await executeQuery(scopes.bob, "SELECT sentinel FROM ada.roads")).preview).toEqual([{ sentinel: "ada roads" }]);
    expect((await executeQuery(scopes.bob, "SELECT sentinel FROM roads")).preview).toEqual([{ sentinel: "bob roads" }]);
    for (const [scope, sql] of [[scopes.cyd, "SELECT * FROM ada.roads"], [scopes.bob, "SELECT * FROM ada.parks"], [scopes.bob, "SELECT * FROM cyd.roads"]] as const) {
      expect(await failure(() => executeQuery(scope, sql))).toEqual({ code: "sql_error", status: 400, message: "The query refers to an unknown table." });
    }
  });

  it("keeps eighteen concurrent and alternating evaluations by owner, member and non-member each in their own reach", async () => {
    const roads = (scope: DatasetScope, sql: string) => executeQuery(scope, sql).then((result) => result.preview, (error: { message: string }) => error.message);
    const drawn = (scope: AccountScope) => renderLayer(scope, layer).then((render) => render.ok
      ? (render.geojson as { features: { properties: { sentinel: string } }[] }).features.map((f) => f.properties.sentinel)
      : render.error!.message);
    const cases: [() => Promise<unknown>, unknown][] = [
      [() => roads(scopes.ada, "SELECT sentinel FROM roads"), [{ sentinel: "ada roads" }]],
      [() => roads(scopes.bob, "SELECT sentinel FROM ada.roads"), [{ sentinel: "ada roads" }]],
      [() => roads(scopes.bob, "SELECT sentinel FROM roads"), [{ sentinel: "bob roads" }]],
      [() => roads(scopes.cyd, "SELECT sentinel FROM ada.roads"), "The query refers to an unknown table."],
      [() => roads(scopes.cyd, "SELECT sentinel FROM roads"), [{ sentinel: "cyd roads" }]],
      [() => drawn(scopes.bob), ["ada roads"]],
      [() => drawn(scopes.cyd), 'The dataset "roads" is not available to you.'],
      [() => drawn(scopes.ada), ["ada roads"]],
      [() => roads(mapEvaluation(scopes.bob, map.id), "SELECT sentinel FROM bob.roads"), [{ sentinel: "bob roads" }]],
    ];
    const results = await Promise.all(Array.from({ length: 18 }, (_, index) => {
      const [run, expected] = cases[index % cases.length];
      return run().then((seen) => ({ seen, expected }));
    }));
    for (const { seen, expected } of results) expect(seen).toEqual(expected);
    for (const [run, expected] of [...cases, ...cases.toReversed(), ...cases]) expect(await run()).toEqual(expected);
  });
});

describe("catalogue discovery under reach", () => {
  const SURFACES = [
    "SELECT view_name AS name FROM duckdb_views() WHERE NOT internal ORDER BY view_name",
    "SELECT table_name AS name FROM information_schema.tables ORDER BY name",
    "SELECT DISTINCT table_name AS name FROM duckdb_columns() WHERE NOT internal ORDER BY name",
    "SELECT name FROM sqlite_master WHERE name NOT LIKE 'duckdb_%' AND name NOT LIKE 'pragma_%' ORDER BY name",
    "SELECT viewname AS name FROM pg_catalog.pg_views WHERE schemaname = 'main' AND viewname NOT LIKE 'duckdb_%' AND viewname NOT LIKE 'pragma_%' AND viewname NOT LIKE 'sqlite_%' ORDER BY viewname",
  ];
  const discovered = (scope: DatasetScope) => boundedEvaluation(async (conn) => {
    const seen: string[][] = [];
    for (const sql of SURFACES) seen.push((await conn.runAndReadAll(await namedSql(conn, sql))).getRowObjects().map((row) => String(row.name)));
    return seen;
  }, { scope });

  it("shows each reachable dataset once under its name and never a synthetic binding", async () => {
    expect(await discovered(scopes.bob)).toEqual(SURFACES.map(() => ["ada.roads", "roads"]));
    expect(await discovered(scopes.cyd)).toEqual(SURFACES.map(() => ["roads"]));
    expect(await discovered(mapEvaluation(scopes.bob, map.id))).toEqual(SURFACES.map(() => ["bob.roads", "roads"]));
    // Bob running Ada's workflow, whose `roads` output is his own roads: Ada's
    // shadowed roads is reachable by its qualified name, and listed nowhere.
    const recipe = createRecipe(scopes.ada, "Survey");
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "roads" } });
    metadataDb().prepare(`INSERT INTO step_runner_outputs (step_id, runner_id, output_table_id, output_table_name, succeeded_at)
      VALUES (?, 'bob', ?, 'roads', ?)`).run(step.id, tables["bob.roads"].id, new Date().toISOString());
    const run = workflowEvaluation(scopes.bob, recipe.id);
    expect(await discovered(run)).toEqual(SURFACES.map(() => ["roads"]));
    expect(await boundedEvaluation(async (conn) => (await conn.runAndReadAll(await namedSql(conn,
      "SELECT a.sentinel AS home, r.sentinel AS output, (SELECT count(*) FROM duckdb_columns() WHERE table_name ILIKE '%dezfil%') AS hidden FROM ada.roads a, roads r"))).getRowObjectsJson(), { scope: run }))
      .toEqual([{ home: "ada roads", output: "bob roads", hidden: "0" }]);
  });
});

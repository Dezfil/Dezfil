import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject } from "@/lib/test-support/sharing";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import { executeQuery } from "./execute";
import { boundedEvaluation } from "./bounded";
import { namedSql } from "./named-sql";
import { workflowEvaluation } from "./context";

/**
 * Qualified names in written SQL. Ada files `roads`, a dataset named
 * `order` and one named `parquet` in her project, where Bob is an editor;
 * both own a `roads`. Every dataset's one row names its owner, so the binding
 * of every form is read off the result.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "qualified-sql-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "order"], ["ada", "parquet"], ["ada", "parks"], ["bob", "roads"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"]], ["ada.roads", "ada.order", "ada.parquet"].map((key) => tables[key].id));
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

const rows = async (scope: AccountScope, sql: string) => (await executeQuery(scope, sql)).preview;

describe("qualified names in written SQL", () => {
  it("binds table references, qualified columns and qualified stars to the dataset each names", async () => {
    expect(await rows(scopes.bob, "SELECT sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, 'SELECT sentinel FROM ADA."Roads"')).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM roads")).toEqual([{ sentinel: "bob roads" }]);
    expect(await rows(scopes.bob, "SELECT ada.roads.sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT roads.sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT a.sentinel AS a, b.sentinel AS b FROM ada.roads a, roads b")).toEqual([{ a: "ada roads", b: "bob roads" }]);
    expect(await rows(scopes.bob, "SELECT roads.* EXCLUDE (lon, lat, geometry) FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT * EXCLUDE (ada.roads.lon, ada.roads.lat, ada.roads.geometry) FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM ada.roads UNION ALL SELECT sentinel FROM roads ORDER BY 1")).toEqual([{ sentinel: "ada roads" }, { sentinel: "bob roads" }]);
    expect(await rows(scopes.bob, "SELECT (SELECT max(sentinel) FROM ada.roads WHERE ada.roads.lon = r.lon) AS other FROM roads r")).toEqual([{ other: "ada roads" }]);
  });

  it("binds computed and list arguments, named-table macros, nested and serialized SQL", async () => {
    expect(await rows(scopes.bob, "SELECT sentinel FROM query_table('ada.' || 'roads')")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM query_table(['roads', 'ada.roads'], true) ORDER BY 1")).toEqual([{ sentinel: "ada roads" }, { sentinel: "bob roads" }]);
    expect(await rows(scopes.bob, "SELECT count FROM histogram_values('ada.roads', lon)")).toEqual([{ count: "1" }]);
    expect((await rows(scopes.bob, "SELECT name FROM pragma_table_info('ada.roads')")).map((row) => row.name)).toEqual(["sentinel", "lon", "lat", "geometry"]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM query('SELECT sentinel FROM ada.roads')")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM query('SELECT sentinel FROM ' || 'ada.roads')")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM json_execute_serialized_sql(json_serialize_sql('SELECT sentinel FROM ada.roads'))")).toEqual([{ sentinel: "ada roads" }]);
  });

  it("keeps aliases, struct paths and common table expressions meaning what they mean", async () => {
    expect(await rows(scopes.bob, "SELECT ada.sentinel FROM roads AS ada")).toEqual([{ sentinel: "bob roads" }]);
    expect(await rows(scopes.bob, "SELECT ada.roads.sentinel AS sentinel FROM (SELECT {'sentinel': 'struct'} AS roads) AS ada")).toEqual([{ sentinel: "struct" }]);
    expect(await rows(scopes.bob, "WITH roads AS (SELECT 'cte' AS sentinel) SELECT r.sentinel, a.sentinel AS other FROM roads r, ada.roads a")).toEqual([{ sentinel: "cte", other: "ada roads" }]);
    expect(await rows(scopes.bob, "WITH ada AS (SELECT {'sentinel': 'struct'} AS roads) SELECT ada.roads.sentinel AS sentinel FROM ada")).toEqual([{ sentinel: "struct" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM memory.main.roads")).toEqual([{ sentinel: "bob roads" }]);
    // A keyed recursive CTE reads its previous iteration as `recurring.<cte>`.
    expect(await rows(scopes.bob, `WITH RECURSIVE t(k, v) USING KEY (k) AS (
      SELECT 1, 1 UNION SELECT k, v + 1 FROM recurring.t WHERE v < 3) SELECT v FROM t`)).toEqual([{ v: 3 }]);
  });

  it("binds a dataset named like a reserved word or a file extension, statically and dynamically", async () => {
    expect(await rows(scopes.bob, 'SELECT sentinel FROM ada."order"')).toEqual([{ sentinel: "ada order" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM query_table('ada.order')")).toEqual([{ sentinel: "ada order" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM ada.parquet")).toEqual([{ sentinel: "ada parquet" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM query_table('ada.parquet')")).toEqual([{ sentinel: "ada parquet" }]);
  });

  it("resolves the home's own qualified name to its plain dataset", async () => {
    expect(await rows(scopes.ada, "SELECT sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.ada, "SELECT ada.roads.sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.ada, "SELECT sentinel FROM query_table('ada.parks')")).toEqual([{ sentinel: "ada parks" }]);
  });
});

describe("runs over qualified names", () => {
  it("records the identity each reference bound, and runs a named verb on the input its qualified name reaches", async () => {
    const { materialize } = await import("@/lib/operations/materialize");
    const { startRun } = await import("@/lib/operations/run");
    const { laneSettled, resetLane } = await import("@/lib/operations/lane");
    const joined = await materialize(scopes.bob, { name: "joined", sql: "SELECT a.sentinel AS a, b.sentinel AS b FROM ada.roads a JOIN roads b ON true", operation: "sql_step" });
    expect(joined.sourceParams).toMatchObject({ inputs: [{ id: tables["ada.roads"].id, name: "roads" }, { id: tables["bob.roads"].id, name: "roads" }] });
    expect(await rows(scopes.bob, "SELECT a, b FROM joined")).toEqual([{ a: "ada roads", b: "bob roads" }]);
    resetLane();
    try {
      await startRun(scopes.bob, { operation: "centroid", parameters: { input: "ada.roads", name: "ada_centroids" } });
      await laneSettled();
      expect(await rows(scopes.bob, "SELECT sentinel FROM ada_centroids")).toEqual([{ sentinel: "ada roads" }]);
      expect((await rows(scopes.bob, "SELECT sentinel FROM roads"))).toEqual([{ sentinel: "bob roads" }]);
    } finally { await laneSettled(); resetLane(); }
  });
});

describe("the published contract", () => {
  it("says how the SQL operation and its tool name another person's dataset", async () => {
    const { buildOpenApiDocument } = await import("@/lib/api/openapi");
    const { buildTools } = await import("@/lib/tools/tools");
    const sentence = "another person's dataset the caller reaches through a project is <sql name>.<dataset>";
    expect(buildOpenApiDocument().paths["/api/query"].post.description).toContain(sentence);
    expect(buildTools().find((tool) => tool.name === "run_sql")?.description).toContain(sentence);
  });
});

describe("the guard over qualified names", () => {
  it("admits a single quoted mount name only as a binding of this evaluation", async () => {
    expect(await rows(scopes.bob, 'SELECT sentinel FROM "ada.roads"')).toEqual([{ sentinel: "ada roads" }]);
    expect(await rows(scopes.bob, "SELECT sentinel FROM query_table('\"ada.roads\"')")).toEqual([{ sentinel: "ada roads" }]);
    for (const sql of ['SELECT * FROM "ada.parks"', 'SELECT * FROM "cyd.roads"', 'SELECT * FROM "x.parquet"', "SELECT * FROM query_table('\"ada.parks\"')"]) {
      await expect(executeQuery(scopes.bob, sql), sql).rejects.toMatchObject({ code: "sql_rejected" });
    }
  });

  it("keeps every file, catalogue-definition and file-shorthand restriction", async () => {
    for (const sql of [
      "SELECT * FROM query_table('ada.' || 'csv')",
      "SELECT * FROM query_table('cyd.parquet')",
      "SELECT sql FROM duckdb_views()",
      "SELECT * FROM duckdb_views() WHERE view_name = 'ada.roads'",
      `SELECT * FROM read_parquet('${path.join(directory, tables["ada.roads"].file).replace(/'/g, "''")}')`,
    ]) await expect(executeQuery(scopes.bob, sql), sql).rejects.toMatchObject({ code: "sql_rejected" });
    expect(await rows(scopes.bob, "SELECT view_name FROM duckdb_views() WHERE NOT internal ORDER BY 1")).toEqual([
      { view_name: "ada.order" }, { view_name: "ada.parquet" }, { view_name: "ada.roads" }, { view_name: "roads" },
    ]);
  });
});

describe("a shadowed home dataset", () => {
  it("is reached by its qualified name through a relation of the statement alone, never a catalogue entry", async () => {
    const recipe = createRecipe(scopes.ada, "Survey");
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "roads" } });
    metadataDb().prepare(`INSERT INTO step_runner_outputs (step_id, runner_id, output_table_id, output_table_name, succeeded_at)
      VALUES (?, 'bob', ?, 'roads', ?)`).run(step.id, tables["bob.roads"].id, new Date().toISOString());
    const run = async (sql: string) => boundedEvaluation(async (conn) =>
      (await conn.runAndReadAll(await namedSql(conn, sql))).getRowObjectsJson(), { scope: workflowEvaluation(scopes.bob, recipe.id) });
    expect(await run("SELECT sentinel FROM roads")).toEqual([{ sentinel: "bob roads" }]);
    expect(await run("SELECT sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await run("SELECT roads.sentinel FROM ada.roads")).toEqual([{ sentinel: "ada roads" }]);
    expect(await run("SELECT sentinel FROM query_table('ada.roads')")).toEqual([{ sentinel: "ada roads" }]);
    expect(await run("SELECT sentinel FROM query('SELECT sentinel FROM ada.roads')")).toEqual([{ sentinel: "ada roads" }]);
    expect(await run("SELECT sentinel FROM bob.roads")).toEqual([{ sentinel: "bob roads" }]);
    expect(await run("SELECT (SELECT string_agg(view_name, ',' ORDER BY view_name) FROM duckdb_views() WHERE NOT internal) AS views, sentinel FROM ada.roads"))
      .toEqual([{ views: "order,parquet,roads", sentinel: "ada roads" }]);
    expect(await run("SELECT count(*) AS n FROM information_schema.tables WHERE table_name LIKE '%dezfil%' OR table_name = 'ada.roads'")).toEqual([{ n: "0" }]);
    await expect(run("SELECT * FROM pragma_table_info('ada.roads')")).rejects.toMatchObject({ code: "sql_error" });
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { testAccountScope } from "@/lib/test-support/accounts";
import { shareProject, unfileDataset } from "@/lib/test-support/sharing";
import { createMap } from "@/lib/map-service";
import { addStep, createRecipe } from "@/lib/metadata/recipes";
import type { AccountScope } from "@/lib/auth/scope";
import type { DataTable } from "@/lib/metadata/tables";
import { boundedEvaluation } from "./bounded";
import { mapEvaluation, workflowEvaluation } from "./context";
import { mountPlanOf } from "./mount-plan";
import { registerTableViews } from "./views";
import type { DatasetScope } from "./access";

/**
 * The evaluation context and its mounts. Every dataset carries one sentinel
 * row naming its owner, so a view that answers for the wrong owner is seen,
 * not inferred. Ada owns `roads` and `parks`, files `roads` in her project,
 * where Bob is an editor; Bob owns his own `roads`; Cyd belongs to nothing.
 */
const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
let scopes: Record<string, AccountScope>;
let tables: Record<string, DataTable>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "mounts-"));
  vi.stubEnv("DEZFIL_DATA_DIR", directory);
  closeMetadataDb(); resetQueryInstance();
  scopes = Object.fromEntries(["ada", "bob", "cyd"].map((id) => [id, testAccountScope(undefined, id)]));
  tables = {};
  for (const [owner, name] of [["ada", "roads"], ["ada", "parks"], ["bob", "roads"], ["cyd", "roads"]]) {
    const file = path.join(directory, `${owner}-${name}.csv`);
    await writeFile(file, `sentinel,lon,lat\n${owner} ${name},1,2\n`);
    tables[`${owner}.${name}`] = await ingestFile(scopes[owner], file, `${name}.csv`);
  }
  shareProject("ada", "P", [["bob", "editor"]], [tables["ada.roads"].id]);
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function sentinels(conn: DuckDBConnection): Promise<Record<string, string>> {
  const views = (await conn.runAndReadAll("SELECT view_name FROM duckdb_views() WHERE NOT internal ORDER BY view_name"))
    .getRowObjects().map((row) => String(row.view_name));
  const seen: Record<string, string> = {};
  for (const view of views) {
    const rows = (await conn.runAndReadAll(`SELECT sentinel FROM "${view.replace(/"/g, '""')}"`)).getRowObjects();
    seen[view] = rows.map((row) => String(row.sentinel)).join(",");
  }
  return seen;
}
const mounted = (scope: DatasetScope) => boundedEvaluation((conn) => sentinels(conn), { scope });

describe("the evaluation context's mounts", () => {
  it("mounts the home's datasets plainly and each other reachable owner's under one qualified name", async () => {
    expect(await mounted(scopes.bob)).toEqual({ "ada.roads": "ada roads", roads: "bob roads" });
    expect(await mounted(scopes.ada)).toEqual({ parks: "ada parks", roads: "ada roads" });
    expect(await mounted(scopes.cyd)).toEqual({ roads: "cyd roads" });
    // Bob in Ada's map: her home, his reach. Her unfiled parks stays out of
    // it; his own roads is his, qualified.
    const map = createMap(scopes.ada, "Shared");
    expect(await mounted(mapEvaluation(scopes.bob, map.id))).toEqual({ "bob.roads": "bob roads", roads: "ada roads" });
    expect(await mounted(mapEvaluation(scopes.ada, map.id))).toEqual({ parks: "ada parks", roads: "ada roads" });
    // Cyd in Ada's map: her home, nothing of it in his reach.
    expect(await mounted(mapEvaluation(scopes.cyd, map.id))).toEqual({ "cyd.roads": "cyd roads" });
  });

  it("resolves the home's own qualified name to its plain view, and the plan to identities", async () => {
    const plan = await boundedEvaluation(async (conn) => mountPlanOf(conn)!, { scope: scopes.ada });
    expect(plan.qualified.get("ada.roads")).toEqual({ view: "roads" });
    expect(plan.qualified.get("ada.parks")).toEqual({ view: "parks" });
    const bob = await boundedEvaluation(async (conn) => mountPlanOf(conn)!, { scope: scopes.bob });
    expect(bob.qualified.get("ada.roads")).toEqual({ view: "ada.roads" });
    expect(bob.views.get("ada.roads")?.dataset.id).toBe(tables["ada.roads"].id);
    expect(bob.plain.get("roads")).toBe("roads");
    expect(bob.views.get("roads")?.dataset.id).toBe(tables["bob.roads"].id);
  });

  it("reserves a workflow's declared outputs ahead of the home's datasets, and reaches a shadowed one only through a hidden binding", async () => {
    const recipe = createRecipe(scopes.ada, "Survey");
    metadataDb().prepare("UPDATE recipes SET project_id = 'P' WHERE id = ?").run(recipe.id);
    const step = addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "roads" } });
    addStep(recipe.id, { operation: "sql_step", parameters: { sql: "SELECT * FROM roads", name: "parks" } });
    // Bob ran the first step: its output, for Bob, is his own `roads`.
    metadataDb().prepare(`INSERT INTO step_runner_outputs (step_id, runner_id, output_table_id, output_table_name, succeeded_at)
      VALUES (?, 'bob', ?, 'roads', ?)`).run(step.id, tables["bob.roads"].id, new Date().toISOString());

    const bobRun = workflowEvaluation(scopes.bob, recipe.id);
    const seen = await boundedEvaluation(async (conn) => ({ views: await sentinels(conn), plan: mountPlanOf(conn)! }), { scope: bobRun });
    // The plain name is Bob's output; Ada's same-named dataset has no view,
    // and the reserved `parks` output (never produced by Bob) has none either.
    expect(seen.views).toEqual({ roads: "bob roads" });
    expect(seen.plan.plain.get("parks")).toBeNull();
    expect(seen.plan.qualified.get("bob.roads")).toEqual({ view: "roads" });
    const shadowed = seen.plan.qualified.get("ada.roads");
    expect(shadowed).toMatchObject({ synthetic: { id: tables["ada.roads"].id } });
    const relation = seen.plan.synthetic.get(tables["ada.roads"].id)!;
    expect(await boundedEvaluation(async (conn) => (await conn.runAndReadAll(`SELECT sentinel FROM ${relation}`)).getRowObjects(), { scope: scopes.ada }))
      .toEqual([{ sentinel: "ada roads" }]);

    // Ada running her own workflow: her `roads` is not her output (no run of
    // hers recorded), so the plain name is reserved and nothing falls back.
    const adaRun = await boundedEvaluation(async (conn) => ({ views: await sentinels(conn), plan: mountPlanOf(conn)! }), { scope: workflowEvaluation(scopes.ada, recipe.id) });
    expect(adaRun.views).toEqual({});
    expect(adaRun.plan.plain.get("roads")).toBeNull();
    expect(adaRun.plan.qualified.get("ada.roads")).toMatchObject({ synthetic: { id: tables["ada.roads"].id } });
    expect(adaRun.plan.qualified.get("ada.parks")).toMatchObject({ synthetic: { id: tables["ada.parks"].id } });
  });

  it("gives concurrent and alternating evaluations by members and non-members each their own reach", async () => {
    const map = createMap(scopes.ada, "Shared");
    const cases: [DatasetScope, Record<string, string>][] = [
      [scopes.ada, { parks: "ada parks", roads: "ada roads" }],
      [scopes.bob, { "ada.roads": "ada roads", roads: "bob roads" }],
      [scopes.cyd, { roads: "cyd roads" }],
      [mapEvaluation(scopes.bob, map.id), { "bob.roads": "bob roads", roads: "ada roads" }],
      [mapEvaluation(scopes.cyd, map.id), { "cyd.roads": "cyd roads" }],
      [mapEvaluation(scopes.ada, map.id), { parks: "ada parks", roads: "ada roads" }],
    ];
    const results = await Promise.all(Array.from({ length: 18 }, (_, index) => {
      const [scope, expected] = cases[index % cases.length];
      return mounted(scope).then((seen) => ({ seen, expected }));
    }));
    for (const { seen, expected } of results) expect(seen).toEqual(expected);
    for (const [scope, expected] of [...cases, ...cases.toReversed()]) expect(await mounted(scope)).toEqual(expected);
  });

  it("grants nothing from a previous registration on the same connection, and follows a withdrawal at the next", async () => {
    const conn = await connectQueryInstance();
    try {
      await registerTableViews(scopes.bob, conn);
      expect(await sentinels(conn)).toEqual({ "ada.roads": "ada roads", roads: "bob roads" });
      await registerTableViews(scopes.cyd, conn);
      expect(await sentinels(conn)).toEqual({ roads: "cyd roads" });
      await registerTableViews(scopes.bob, conn);
      unfileDataset("P", tables["ada.roads"].id);
      await registerTableViews(scopes.bob, conn);
      expect(await sentinels(conn)).toEqual({ roads: "bob roads" });
    } finally { conn.disconnectSync(); }
  });
});

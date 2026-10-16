import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeMetadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestFile } from "@/lib/ingest/ingest";
import { resetQueryInstance } from "@/lib/duckdb";
import { executeQuery } from "./execute";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { getPublishedView, publishMap, resetPublishCache } from "@/lib/publish/publish-service";
import { metadataDb } from "@/lib/metadata/db";
import type { AccountScope } from "@/lib/auth/scope";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string, scopes: Record<string, AccountScope>;
const owners = ["alice", "bob", "admin"];
beforeEach(async () => {
  directory = await mkdtemp(path.join(initialDir, "sql-ownership-")); process.env.DEZFIL_DATA_DIR = directory;
  closeMetadataDb(); resetQueryInstance(); resetPublishCache(); scopes = {};
  for (const owner of owners) {
    scopes[owner] = testAccountScope(undefined, owner);
    const file = path.join(directory, `${owner}.csv`); await writeFile(file, `sentinel,lon,lat\n${owner},1,2\n`);
    await ingestFile(scopes[owner], file, "roads.csv");
  }
  metadataDb().prepare("UPDATE accounts SET is_admin = 1 WHERE id = 'admin'").run();
});
afterEach(async () => { closeMetadataDb(); resetQueryInstance(); resetPublishCache(); process.env.DEZFIL_DATA_DIR = initialDir; await rm(directory, { recursive: true, force: true }); });
const forms = [
  "SELECT memory.main.roads.sentinel FROM memory.main.roads",
  "SELECT memory.roads.sentinel FROM memory.roads",
  `SELECT sentinel FROM query_table(['memory.main.roads'], true)`,
  `SELECT sentinel FROM query_table('"memory"."main"."roads"')`,
  "SELECT sentinel FROM roads", "SELECT sentinel FROM main.roads", "SELECT sentinel FROM memory.main.roads", "SELECT sentinel FROM memory.roads",
  "SELECT sentinel FROM query_table('roads')", "SELECT sentinel FROM query_table('main.' || 'roads')",
  "SELECT sentinel FROM query_table('memory.main.' || 'roads')", "SELECT sentinel FROM query('SELECT sentinel FROM memory.main.' || 'roads')",
  "WITH r AS (SELECT * FROM main.roads) SELECT sentinel FROM r", "SELECT roads.sentinel FROM memory.main.roads",
];
it.each(forms)("runs %s only against each account's local bindings", async sql => {
  for (const owner of [...owners, ...owners.toReversed()]) expect((await executeQuery(scopes[owner], sql)).preview).toEqual([{ sentinel: owner }]);
});
it("keeps simultaneous same-name reads independent and leaves no shared dataset catalogue", async () => {
  const results = await Promise.all(Array.from({ length: 18 }, (_, index) => {
    const owner = owners[index % owners.length]; return executeQuery(scopes[owner], "SELECT sentinel FROM roads").then(result => ({ owner, result }));
  }));
  for (const { owner, result } of results) expect(result.preview).toEqual([{ sentinel: owner }]);
  for (const owner of owners) {
    const result = await executeQuery(scopes[owner], "SELECT database_name, schema_name, view_name FROM duckdb_views() WHERE NOT internal");
    expect(result.preview).toEqual([{ database_name: "temp", schema_name: "main", view_name: "roads" }]);
  }
});
it("uses the publisher's data after deactivation rather than another account's same-named table", async () => {
  for (const owner of owners) {
    const map = createMap(scopes[owner], "Public projection"), layer = await createLayer(scopes[owner], map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    const { token } = publishMap(scopes[owner], map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    metadataDb().prepare("UPDATE accounts SET status = 'deactivated' WHERE id = ?").run(owner);
    const view = await getPublishedView(token, Date.now()); expect(view?.layers[0].id).toBe(layer.id);
    expect(view?.layers[0].render.geojson).toMatchObject({ features: [{ properties: { sentinel: owner } }] });
  }
});
it("refuses a missing evaluation scope before mounting or querying", async () => {
  await expect(executeQuery(undefined as unknown as AccountScope, "SELECT sentinel FROM roads")).rejects.toMatchObject({ code: "authentication_required" });
});

it("does not mistake a struct path or CTE alias for a database qualifier", async () => {
  const result = await executeQuery(scopes.alice, "WITH memory AS (SELECT {'sentinel': 'struct'} AS roads) SELECT memory.roads.sentinel AS sentinel FROM memory");
  expect(result.preview).toEqual([{ sentinel: "struct" }]);
});
it("keeps dynamic arguments under table-function binder restrictions", async () => {
  await expect(executeQuery(scopes.alice, "SELECT * FROM query_table((SELECT 'roads'))")).rejects.toMatchObject({ code: "sql_error" });
  await expect(executeQuery(scopes.alice, "SELECT * FROM query('DELETE FROM roads')")).rejects.toMatchObject({ code: "sql_rejected" });
});
it("carries account scope through classification, fields, extent, preview, search and exports", async () => {
  const { classifyFill } = await import("@/lib/style/classify");
  const { baseFields, layerFieldStats, sliderPreviewData } = await import("@/lib/layer-service");
  const { layerExtent } = await import("@/lib/extent-service");
  const { searchValues } = await import("@/lib/search/value-search");
  const { exportLayerResult, exportQueryResult } = await import("@/lib/export/layer-export");
  for (const owner of owners) {
    const scope = scopes[owner], sql = "SELECT * FROM query('SELECT * FROM memory.main.roads')";
    const map = createMap(scope, "Local consumers"), layer = await createLayer(scope, map.id, { name: "Roads", sql }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
    expect((await classifyFill(scope, sql, "sentinel", "categorical"))).toMatchObject({ map: [{ value: owner }] });
    expect((await baseFields(scope, layer)).some(field => field.name === "sentinel")).toBe(true);
    expect(await layerFieldStats(scope, layer, "sentinel")).toMatchObject({ values: [owner] });
    expect(await layerExtent(scope, layer)).toMatchObject({ kind: "extent", box: [1, 2, 1, 2] });
    expect(await sliderPreviewData(scope, layer)).toMatchObject({ sourceCount: 1 });
    expect((await searchValues(scope, [{ layerId: layer.id, layerName: layer.name, sql }], owner)).values).toMatchObject([{ value: owner }]);
    for (const result of [await exportLayerResult(scope, layer, "csv"), await exportQueryResult(scope, sql, "csv")]) {
      try { expect(await readFile(result.path, "utf8")).toContain(owner); } finally { await result.cleanup(); }
    }
  }
});
it.each(["SELECT * FROM query_table('memory.main.' || 'roads')", "SELECT * FROM query_table(['memory.main.roads'], true)"])("materializes %s with the initiating account's own provenance", async sql => {
  const { materialize } = await import("@/lib/operations/materialize");
  const { scopedDatasets } = await import("./access");
  for (const owner of owners) {
    const scope = scopes[owner], source = scopedDatasets(scope)[0];
    const result = await materialize(scope, { name: "copied", sql, operation: "sql_step" });
    expect((await executeQuery(scope, "SELECT sentinel FROM copied")).preview).toEqual([{ sentinel: owner }]);
    expect(result.sourceParams).toMatchObject({ inputs: [{ id: source.id, name: source.name }] });
    expect(result.sourceParams).toMatchObject({ sql });
  }
});

it("holds artifact and identity evidence across refresh, delete, reuse, cancellation and reset", async () => {
  const { boundedEvaluation, EvaluationCancelled } = await import("./bounded");
  const { scopedDatasets } = await import("./access");
  const { retireArtifact, retirementsSettled } = await import("@/lib/ingest/retire");
  const { existsSync } = await import("node:fs");
  const source = scopedDatasets(scopes.alice)[0];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pending = boundedEvaluation(async (conn, bounds) => {
    entered.resolve(); await release.promise;
    const rows = (await conn.runAndReadAll("SELECT sentinel FROM roads")).getRowObjects();
    return { rows, bound: bounds.bindings!.byName.get("roads") };
  }, { scope: scopes.alice, pinBindings: true });
  await entered.promise;
  try {
    const replacementFile = path.join(directory, "replacement.csv");
    await writeFile(replacementFile, "sentinel,lon,lat\nnew-alice,3,4\n");
    const replacement = await ingestFile(scopes.alice, replacementFile, "replacement.csv");
    metadataDb().prepare("UPDATE data_tables SET file = ? WHERE id = ?").run(replacement.file, source.id);
    expect((await executeQuery(scopes.alice, "SELECT sentinel FROM roads")).preview).toEqual([{ sentinel: "new-alice" }]);
    metadataDb().prepare("DELETE FROM data_tables WHERE id = ?").run(source.id);
    metadataDb().prepare("UPDATE data_tables SET name = 'roads' WHERE id = ?").run(replacement.id);
    retireArtifact(path.join(directory, source.file));
    resetQueryInstance();
    expect((await executeQuery(scopes.alice, "SELECT sentinel FROM memory.main.roads")).preview).toEqual([{ sentinel: "new-alice" }]);
    expect((await executeQuery(scopes.bob, "SELECT sentinel FROM roads")).preview).toEqual([{ sentinel: "bob" }]);
    expect(existsSync(path.join(directory, source.file))).toBe(true);
  } finally { release.resolve(); }
  expect(await pending).toMatchObject({ rows: [{ sentinel: "alice" }], bound: { id: source.id, file: source.file } });
  await retirementsSettled();
  expect(existsSync(path.join(directory, source.file))).toBe(false);

  const caller = new AbortController();
  const cancelled = boundedEvaluation(async conn => {
    caller.abort();
    await conn.runAndReadAll("SELECT sentinel FROM roads");
  }, { scope: scopes.alice, signal: caller.signal });
  await expect(cancelled).rejects.toBeInstanceOf(EvaluationCancelled);
  expect((await executeQuery(scopes.bob, "SELECT sentinel FROM roads")).preview).toEqual([{ sentinel: "bob" }]);
});

it("recreates every local view in cold and warm many-dataset evaluations", async () => {
  const { scopedDatasets } = await import("./access");
  const { insertTable } = await import("@/lib/metadata/tables");
  const { boundedEvaluation } = await import("./bounded");
  const { limits } = await import("@/lib/limits");
  for (const owner of owners) {
    const original = scopedDatasets(scopes[owner])[0];
    for (let i = 1; i < 96; i++) {
      const file = path.join("tables", `${owner}-${i}.parquet`);
      await copyFile(path.join(directory, original.file), path.join(directory, file));
      insertTable(scopes[owner], { ...original, id: `${owner}-${i}`, name: `roads_${i}`, file });
    }
  }
  resetQueryInstance();
  const timings: number[] = [];
  for (const owner of [...owners, ...owners]) {
    const started = performance.now();
    const views = await boundedEvaluation(async conn => {
      const result = await conn.runAndReadAll("SELECT count(*) AS n FROM duckdb_views() WHERE NOT internal");
      expect((await conn.runAndReadAll("SELECT sentinel FROM roads_95")).getRowObjects()).toEqual([{ sentinel: owner }]);
      return Number(result.getRowObjects()[0].n);
    }, { scope: scopes[owner] });
    expect(views).toBe(96);
    timings.push(performance.now() - started);
  }
  expect(Math.max(...timings)).toBeLessThan(limits.queryTimeoutMs);
  await writeFile(path.join(initialDir, "query-mount-cost.json"), JSON.stringify({ datasetsPerAccount: 96, owners: owners.length, coldThenWarmMs: timings, budgetMs: limits.queryTimeoutMs }, null, 2));
});

it("preserves exact large numeric literals while translating qualified names", async () => {
  const result = await executeQuery(scopes.alice, "SELECT 9223372036854775806 AS exact FROM memory.main.roads");
  expect(result.preview).toEqual([{ exact: "9223372036854775806" }]);
});

it("keeps pending-adoption publications on their named dataset through first-account setup", async () => {
  const map = createMap(scopes.alice, "Pending publication");
  await createLayer(scopes.alice, map.id, { name: "Roads", sql: "SELECT * FROM query_table('memory.main.roads')" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  const { token } = publishMap(scopes.alice, map.id, {}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  // Recreate a pre-account installation through inserts. Ownership immutability
  // deliberately refuses turning existing owned rows back into legacy rows.
  let db = metadataDb();
  const rows = [
    ["data_tables", db.prepare("SELECT * FROM data_tables WHERE owner_id = 'alice'").all()],
    ["maps", db.prepare("SELECT * FROM maps").all()],
    ["layers", db.prepare("SELECT * FROM layers").all()],
  ] as [string, Record<string, unknown>[]][];
  closeMetadataDb();
  await rm(path.join(directory, "metadata.sqlite"));
  db = metadataDb();
  for (const [table, saved] of rows) for (const row of saved) {
    if ("owner_id" in row) row.owner_id = null;
    if ("home_account_id" in row) row.home_account_id = null;
    if ("last_changed_by" in row) row.last_changed_by = null;
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  }
  resetPublishCache();
  expect((await getPublishedView(token, Date.now()))?.layers[0].render.geojson).toMatchObject({ features: [{ properties: { sentinel: "alice" } }] });
  const { createFirstAccount } = await import("@/lib/auth/accounts");
  await createFirstAccount({ name: "Adopter", email: "adopter@example.test", password: "a sufficient fixture passphrase" });
  expect((await getPublishedView(token, Date.now()))?.layers[0].render.geojson).toMatchObject({ features: [{ properties: { sentinel: "alice" } }] });
});

it("distinguishes column aliases and a table named main from catalog qualifiers", async () => {
  expect((await executeQuery(scopes.alice, "SELECT 1 AS memory, memory.main.roads.sentinel FROM memory.main.roads")).preview).toEqual([{ memory: 1, sentinel: "alice" }]);
  metadataDb().prepare("UPDATE data_tables SET name = 'main' WHERE owner_id = 'alice'").run();
  expect((await executeQuery(scopes.alice, "SELECT memory.main.sentinel FROM memory.main")).preview).toEqual([{ sentinel: "alice" }]);
});

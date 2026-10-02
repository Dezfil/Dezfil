import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { testAccountScope } from "@/lib/test-support/accounts";
import { ingestFile } from "@/lib/ingest/ingest";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import { executeQuery } from "./execute";
import { namedSql } from "./named-sql";
import { scopedDatasets } from "./access";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string;
const scope = () => testAccountScope();
beforeEach(async () => {
 directory = await mkdtemp(path.join(initialDir, "file-sql-")); process.env.DEZFIL_DATA_DIR = directory;
 closeMetadataDb(); resetQueryInstance();
 const source = path.join(directory, "source.csv"); await writeFile(source, "sentinel,lon,lat\nowned,1,2\n");
 await ingestFile(scope(), source, "roads.csv");
});
afterEach(async () => { vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = initialDir; await rm(directory, { recursive: true, force: true }); });
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const direct = [
 "read_parquet", "parquet_scan", "read_csv", "read_csv_auto", "read_json", "read_json_auto", "read_ndjson", "read_json_objects", "read_text", "read_blob", "read_duckdb", "glob", "sniff_csv", "parquet_metadata", "parquet_schema", "parquet_file_metadata", "parquet_kv_metadata", "parquet_full_metadata", "ST_Read", "ST_Read_Meta", "ST_ReadOSM", "ST_ReadSHP", "shapefile_meta",
];
it("refuses every file reader before any user target can be bound or probed", async () => {
 const conn = await connectQueryInstance();
 const calls = vi.spyOn(conn, "runAndReadAll");
 try {
  for (const fn of direct) {
   calls.mockClear();
   await expect(namedSql(conn, `SELECT * FROM ${fn}('/absent-private.parquet')`), fn).rejects.toMatchObject({ code: "sql_rejected" });
   expect(calls.mock.calls.every(([sql]) => String(sql).startsWith("SELECT json_serialize_sql("))).toBe(true);
  }
 } finally { conn.disconnectSync(); }
});
it.each(["duckdb_connection_count", "duckdb_approx_database_count", "duckdb_memory"])("refuses instance-wide telemetry from %s before binding", async fn => {
 const conn = await connectQueryInstance();
 const calls = vi.spyOn(conn, "runAndReadAll");
 try {
  await expect(namedSql(conn, `SELECT * FROM ${fn}()`)).rejects.toMatchObject({ code: "sql_rejected", status: 400 });
  expect(calls.mock.calls.every(([sql]) => String(sql).startsWith("SELECT json_serialize_sql("))).toBe(true);
 } finally { conn.disconnectSync(); }
});
it("refuses owned, foreign, missing and scratch paths with the same result", async () => {
 const own = scopedDatasets(scope())[0];
 const bob = testAccountScope(undefined, "bob");
 const source = path.join(directory, "bob.csv"); await writeFile(source, "secret\nforeign\n"); await ingestFile(bob, source, "roads.csv");
 for (const file of [own.file, scopedDatasets(bob)[0].file, "tables/missing.parquet", "tmp/tile-export.parquet"]) {
  for (const sql of [`SELECT * FROM read_parquet(${lit(path.join(directory, file))})`, `SELECT * FROM ${lit(path.join(directory, file))}`]) {
   await expect(executeQuery(scope(), sql)).rejects.toMatchObject({ code: "sql_rejected", message: "Queries must use named datasets. File access and engine path discovery are not accepted." });
  }
 }
 expect((await executeQuery(scope(), "SELECT sentinel FROM roads")).preview).toEqual([{ sentinel: "owned" }]);
});
const indirect = [
 "WITH x AS (SELECT * FROM read_parquet('missing.parquet')) SELECT * FROM x",
 "SELECT (SELECT content FROM read_text('missing'))",
 "SELECT * FROM query('SELECT * FROM ' || 'read_parquet(''missing.parquet'')')",
 "SELECT * FROM query_table('missing.' || 'parquet')",
 "SELECT * FROM query_table('main.parquet')",
 "SELECT #1 FROM duckdb_views()",
 "SELECT * FROM query_table(['roads', 'missing.parquet'], true)",
 "SELECT * FROM query_table(current_setting('allowed_' || 'directories')[1])",
 "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT * FROM read_text(''missing'')'))",
 "SELECT * FROM histogram('missing.parquet', sentinel)",
 "SELECT * FROM histogram_values('missing.parquet', sentinel)",
 "SELECT * FROM pragma_table_info('missing.parquet')",
 "SELECT * FROM pragma_show('SELECT * FROM read_parquet(''missing.parquet'')')",
 "SELECT * FROM summary((SELECT * FROM read_parquet('missing.parquet')))",
 "SELECT * FROM sql_auto_complete('SELECT * FROM ''/private/')",
 "SELECT view_name FROM duckdb_views() v(a,b,c,d,e,f,g,h,i,j,k,view_name,l)",
 "SELECT (SELECT v.sql) FROM duckdb_views() v",
 "SELECT * FROM query_table((SELECT sql FROM duckdb_views() LIMIT 1))",
 "PIVOT duckdb_views() ON sql USING count(*)",
 "SELECT sql FROM duckdb_views()",
 "SELECT sql FROM main.duckdb_views",
 "SELECT sql FROM query_table('duckdb_' || 'views')",
 "SELECT view_definition FROM information_schema.views",
 "SELECT definition FROM pg_catalog.pg_views",
 "SELECT sql FROM sqlite_master",
 "SELECT * FROM duckdb_views()",
 "SELECT to_json(v) FROM duckdb_views() v",
 "SELECT COLUMNS('.*') FROM duckdb_views()",
 "SELECT pg_get_viewdef(1)",
 "SELECT current_setting('allowed_directories')",
 "SELECT * FROM duckdb_settings()",
 "SELECT * FROM pg_catalog.pg_settings",
 "SELECT * FROM duckdb_external_file_cache()",
 "SELECT * FROM duckdb_temporary_files()",
 "SELECT * FROM duckdb_logs_parsed('QueryLog')",
 "SELECT current_query()",
];
it.each(indirect)("refuses indirect file or discovery SQL: %s", async sql => {
 await expect(executeQuery(scope(), sql)).rejects.toMatchObject({ code: "sql_rejected" });
});
it("keeps safe name discovery, expressions, CTEs and dynamic dataset SQL", async () => {
 for (const sql of ["SELECT sentinel FROM query_table('ro' || 'ads')", "SELECT sentinel FROM query('SELECT sentinel FROM roads')", "WITH \"x.parquet\" AS (SELECT * FROM roads) SELECT sentinel FROM \"x.parquet\"", "SELECT 'read_parquet(' AS text", "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT sentinel FROM roads'))", "SELECT * FROM pragma_show('roads')", "WITH duckdb_views AS (SELECT 1 AS x) SELECT * FROM query_table('duckdb_views')", "SELECT database_name, schema_name, view_name FROM duckdb_views() WHERE NOT internal", "SELECT * FROM information_schema.tables WHERE table_name = 'roads'"]) await expect(executeQuery(scope(), sql)).resolves.toBeDefined();
});
it("refuses saved file SQL without changing its persisted text or publication", async () => {
 const { createMap } = await import("@/lib/map-service"); const { createLayer } = await import("@/lib/layer-service");
 const { publishMap, getPublishedView, resetPublishCache } = await import("@/lib/publish/publish-service");
 const map = createMap(scope(), "Saved file query"), layer = await createLayer(scope(), map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
 const sql = `SELECT * FROM read_parquet(${lit(path.join(directory, scopedDatasets(scope())[0].file))})`;
 metadataDb().prepare("UPDATE layers SET sql = ? WHERE id = ?").run(sql, layer.id);
 const { token } = publishMap(scope(), map.id); resetPublishCache();
 const view = await getPublishedView(token, Date.now());
 expect(view?.layers[0]).toMatchObject({ render: { error: { code: "sql_rejected" } } });
 expect(metadataDb().prepare("SELECT sql FROM layers WHERE id = ?").get(layer.id)).toEqual({ sql });
 expect(metadataDb().prepare("SELECT publish_token FROM maps WHERE id = ?").get(map.id)).toEqual({ publish_token: token });
 resetPublishCache();
});

it("guards dependency analysis before it can evaluate a computed argument", async () => {
 const { queryInputs, queryInputsStrict } = await import("@/lib/operations/inputs");
 const conn = await connectQueryInstance();
 try {
  for (const analyze of [queryInputs, queryInputsStrict]) {
   await expect(analyze(conn, "SELECT * FROM query_table((SELECT content FROM read_text('missing')))", () => null)).rejects.toMatchObject({ code: "sql_rejected" });
   await expect(analyze(conn, "SELECT * FROM query('SELECT * FROM read_parquet(''missing'')')", () => null)).rejects.toMatchObject({ code: "sql_rejected" });
  }
 } finally { conn.disconnectSync(); }
});
it.each(["reader", "projection"])("refuses %s file SQL through every private SQL consumer", async kind => {
 const { createMap } = await import("@/lib/map-service");
 const { createLayer, renderLayer, baseFields, layerFieldStats, sliderPreviewData } = await import("@/lib/layer-service");
 const { classifyFill } = await import("@/lib/style/classify");
 const { layerExtent } = await import("@/lib/extent-service");
 const { searchValues } = await import("@/lib/search/value-search");
 const { exportLayerResult, exportQueryResult } = await import("@/lib/export/layer-export");
 const { materialize } = await import("@/lib/operations/materialize");
 const map = createMap(scope(), "Consumers"), layer = await createLayer(scope(), map.id, { name: "Roads", sql: "SELECT * FROM roads" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
 const sql = `SELECT * FROM read_parquet(${lit(path.join(directory, scopedDatasets(scope())[0].file))})`;
 const consumerSql = kind === "projection" ? "SELECT ST_Transform(geometry, '+init=private-projection:local +type=crs', 'EPSG:4326', true) AS geometry, sentinel FROM roads" : sql;
 const saved = { ...layer, sql: consumerSql };
 for (const result of [
  () => baseFields(scope(), saved), () => layerFieldStats(scope(), saved, "sentinel"),
  () => sliderPreviewData(scope(), saved), () => classifyFill(scope(), consumerSql, "sentinel", "categorical"),
  () => exportLayerResult(scope(), saved, "csv"), () => exportQueryResult(scope(), consumerSql, "csv"),
  () => materialize(scope(), { name: "denied", sql: consumerSql, operation: "sql_step" }),
  () => createLayer(scope(), map.id, { name: "File query", sql: consumerSql }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision }),
 ]) await expect(result()).rejects.toMatchObject({ code: "sql_rejected" });
 expect(await renderLayer(scope(), saved)).toMatchObject({ ok: false, error: { code: "sql_rejected" } });
 await expect(layerExtent(scope(), saved)).rejects.toMatchObject({ code: "sql_rejected" });
 expect(await searchValues(scope(), [{ layerId: layer.id, layerName: layer.name, sql: consumerSql }], "owned")).toEqual([]);
 const { computeWidgetValues } = await import("@/lib/widget-service");
 const widgets = [{ id: "count", type: "formula" as const, layerId: saved.id, title: "Count", field: null, agg: "count" as const, aggField: null, unit: null, note: null, format: null, visible: true }];
 expect(await computeWidgetValues(scope(), { ...map, widgets }, [saved], [])).toMatchObject({ widgets: [{ id: "count", errorCode: "sql_rejected" }] });
 expect(scopedDatasets(scope())).toHaveLength(1);
});
it("keeps outer queries over safe catalogue projections and unrelated dataset columns", async () => {
 for (const sql of [
  "SELECT * FROM (SELECT view_name FROM duckdb_views() WHERE NOT internal) q",
  "SELECT r.* FROM roads r JOIN duckdb_views() v ON v.view_name = 'roads' WHERE NOT v.internal",
 ]) await expect(executeQuery(scope(), sql)).resolves.toBeDefined();

});
it("does not let an unsupported dynamic target shape skip admission", async () => {
 const conn = await connectQueryInstance();
 try {
  for (const sql of ["SELECT * FROM query_table([NULL, 'missing.parquet'], true)", "SELECT * FROM query_table(NULL)", "SELECT * FROM query(NULL)"]) {
   await expect(namedSql(conn, sql)).rejects.toMatchObject({ code: "sql_rejected" });
  }
 } finally { conn.disconnectSync(); }
});
it("keeps safe table macros, serialized SQL and their named provenance", async () => {
 const { materialize } = await import("@/lib/operations/materialize");
 const source = scopedDatasets(scope())[0];
 for (const [name, sql] of [
  ["macro_output", "SELECT * FROM histogram_values('memory.main.roads', lon)"],
  ["serialized_output", "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT * FROM roads'))"],
 ]) {
  const table = await materialize(scope(), { name, sql, operation: "sql_step" });
  expect(table.sourceParams).toMatchObject({ sql, inputs: [{ id: source.id, name: source.name }] });
 }
 expect((await executeQuery(scope(), "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT 9223372036854775807::BIGINT AS n'))")).preview).toEqual([{ n: "9223372036854775807" }]);
});

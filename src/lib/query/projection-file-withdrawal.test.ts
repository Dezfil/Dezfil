import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeQuery } from "./execute";
import { testAccountScope } from "@/lib/test-support/accounts";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { connectQueryInstance, resetQueryInstance } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { PROJECTION_REJECTION } from "./projection-policy";
import { namedSql } from "./named-sql";

const initialDir = process.env.DEZFIL_DATA_DIR!;
let directory: string, file: string, crs: string;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const scope = () => testAccountScope();
const transform = (from: string, to = "'EPSG:4326'") => `ST_Transform(ST_Point(1, 2), ${from}, ${to}, always_xy := true)`;
beforeEach(async () => {
 directory = await mkdtemp(path.join(initialDir, "projection-")); process.env.DEZFIL_DATA_DIR = directory;
 closeMetadataDb(); resetQueryInstance();
 file = path.join(directory, "private-projection");
 await writeFile(file, "<local> +proj=longlat +ellps=WGS84 +pm=10 +type=crs <>\n");
 crs = `+init=${file}:local +type=crs`;
});
afterEach(async () => {
 vi.restoreAllMocks(); closeMetadataDb(); resetQueryInstance(); process.env.DEZFIL_DATA_DIR = initialDir;
 await rm(directory, { recursive: true, force: true });
});
it("refuses projection definition files outside the engine's allowed directories", async () => {
 await expect(executeQuery(scope(), `SELECT ST_AsText(${transform(lit(crs))}) AS value`)).rejects.toMatchObject({ code: "sql_rejected" });
});
it("rejects direct definitions before a native function can bind or execute", async () => {
 const conn = await connectQueryInstance(); const calls = vi.spyOn(conn, "runAndReadAll");
 try {
  for (const expression of [transform(lit(crs)), transform("'EPSG:4326'", lit(crs)), `ST_SetCRS(ST_Point(1, 2), ${lit(crs)})`, `ST_Point(1, 2)::GEOMETRY(${lit(crs)})`]) {
   calls.mockClear();
   await expect(namedSql(conn, `SELECT ${expression}`)).rejects.toMatchObject({ code: "sql_rejected", message: PROJECTION_REJECTION });
   expect(calls.mock.calls.every(([sql]) => String(sql).startsWith("SELECT json_serialize_sql("))).toBe(true);
  }
 } finally { conn.disconnectSync(); }
});
it("refuses computed and per-row definitions, source and target, before their native use", async () => {
 const source = path.join(directory, "sources.csv"); await writeFile(source, `crs\n${crs}\n`); await ingestFile(scope(), source, "sources.csv");
 for (const expression of [`${lit("+init=")} || ${lit(file + ":local +type=crs")}`, "crs", `CASE WHEN random() < 2 THEN crs ELSE 'EPSG:4326' END`]) {
  for (const value of [transform(expression), transform("'EPSG:4326'", expression)]) {
   await expect(executeQuery(scope(), `SELECT ST_AsText(${value}) AS value FROM sources`)).rejects.toMatchObject({ code: "sql_rejected", message: PROJECTION_REJECTION });
  }
 }
 const nested = `SELECT ST_AsText(${transform("crs")}) AS value FROM sources`;
 for (const sql of [`SELECT * FROM query(${lit(nested)})`, `SELECT * FROM json_execute_serialized_sql(json_serialize_sql(${lit(nested)}))`]) await expect(executeQuery(scope(), sql)).rejects.toMatchObject({ code: "sql_rejected" });
});
it("refuses all file-bearing CRS forms independently of existence and projection validity", async () => {
 for (const target of [file, file + "-missing", "relative-grid", "https://example.invalid/grid"]) {
  for (const definition of [
   `+init=${target}:local +type=crs`, `init=${target}:local +type=crs`,
   `+proj=longlat +ellps=WGS84 +init = ${target}:local +type=crs`,
   `+title='a +init=${target}:local +type=crs ' +proj=longlat +ellps=WGS84`,
   `+proj=longlat +ellps=WGS84 +nadgrids=${target} +type=crs`,
   `+proj=longlat +ellps=WGS84 +geoidgrids=@${target} +type=crs`,
   `+proj=pipeline +step +proj=hgridshift +grids=${target}`,
   `+proj=deformation +xy_grids=${target}`, `+proj=deformation +z_grids=${target}`,
   `+proj=tinshift +file=${target}`, `+proj=defmodel +model=${target}`,
   `PROJCS["Local",EXTENSION["PROJ4","+proj=longlat +init=${target}:local"]]`,
   `GEOGCS["Local",DATUM["Local",EXTENSION["PROJ4_GRIDS","${target}"]]]`,
   `BOUNDCRS[PARAMETERFILE["Grid","${target}"]]`,
   `CONVERSION["Local",METHOD["PROJ-based operation method: +proj=tinshift +file=${target}"]]`,
   JSON.stringify({ type: "BoundCRS", transformation: { parameters: [{ name: "Grid", value: target }] } }).replace('"value"', '"\\u0076alue"'),
  ]) {
   await expect(executeQuery(scope(), `SELECT ${transform(lit(definition))}`), definition).rejects.toMatchObject({ code: "sql_rejected" });
  }
 }
});
it("preserves EPSG, inline CRS, typed geometry, boxes, points and computed CRS values", async () => {
 const definitions = ["EPSG:4326", "+proj=longlat +ellps=WGS84 +pm=10 +type=crs", "+proj=longlat +datum=WGS84 +nadgrids=@null +type=crs"];
 for (const crs of definitions) {
  const result = await executeQuery(scope(), `SELECT ST_AsText(${transform("crs")}) AS value FROM (VALUES (${lit(crs)})) t(crs)`);
  expect(result.preview).toEqual([{ value: crs.includes("pm=10") ? "POINT (11 2)" : "POINT (1 2)" }]);
 }
 for (const sql of [
  "SELECT ST_Transform(ST_SetCRS(ST_Point(1,2), 'EPSG:4326'), 'EPSG:3857') AS geom",
  "SELECT ST_Transform(ST_SetCRS(ST_Point(1,2), 'EPSG:4326'), 'EPSG:3857', true) AS geom",
  "SELECT ST_Transform(ST_Point(1,2)::GEOMETRY('EPSG:4326'), 'EPSG:3857', always_xy := true) AS geom",
  "SELECT ST_Transform(ST_Point2D(1,2), 'EPSG:4326', 'EPSG:3857', true) AS geom",
  "SELECT ST_Transform(ST_MakeBox2D(ST_Point2D(1,2), ST_Point2D(2,3)), 'EPSG:4326', 'EPSG:3857', true) AS geom",
  "SELECT ST_Transform(ST_Point(1,2), 'EPSG:' || '4326', 'EPSG:3857', true) AS geom",
 ]) await expect(executeQuery(scope(), sql), sql).resolves.toBeDefined();
});
it("refuses row-sourced projection reads during export, materialization and widget evaluation", async () => {
 const { createMap } = await import("@/lib/map-service");
 const { createLayer } = await import("@/lib/layer-service");
 const { materialize } = await import("@/lib/operations/materialize");
 const { exportQueryResult } = await import("@/lib/export/layer-export");
 const { computeWidgetValues } = await import("@/lib/widget-service");
 const { scopedDatasets } = await import("./access");
 const source = path.join(directory, "sources.csv"); await writeFile(source, `crs,lon,lat\n${crs},1,2\n`); await ingestFile(scope(), source, "sources.csv");
 const map = createMap(scope(), "Projection consumers"), layer = await createLayer(scope(), map.id, { name: "Projection", sql: "SELECT * FROM sources" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
 const sql = `SELECT ST_X(${transform("crs")}) AS value FROM sources`;
 await expect(exportQueryResult(scope(), sql, "csv")).rejects.toMatchObject({ code: "sql_rejected", message: PROJECTION_REJECTION });
 await expect(materialize(scope(), { name: "denied", sql, operation: "sql_step" })).rejects.toMatchObject({ code: "sql_rejected", message: PROJECTION_REJECTION });
 const widgets = [{ id: "projection", type: "formula" as const, layerId: layer.id, title: "Value", field: "value", agg: "sum" as const, aggField: null, unit: null, note: null, format: null, visible: true }];
 expect(await computeWidgetValues(scope(), { ...map, widgets }, [{ ...layer, sql }], [])).toMatchObject({ widgets: [{ id: "projection", errorCode: "sql_rejected", error: PROJECTION_REJECTION }] });
 expect(scopedDatasets(scope()).map(table => table.name)).toEqual(["sources"]);
});
it("keeps saved publication SQL intact while rejecting a row-sourced projection file", async () => {
 const { createMap } = await import("@/lib/map-service");
 const { createLayer } = await import("@/lib/layer-service");
 const { publishMap, getPublishedView, resetPublishCache } = await import("@/lib/publish/publish-service");
 const source = path.join(directory, "sources.csv"); await writeFile(source, `crs,lon,lat\n${crs},1,2\n`); await ingestFile(scope(), source, "sources.csv");
 const map = createMap(scope(), "Saved projection"), layer = await createLayer(scope(), map.id, { name: "Projection", sql: "SELECT * FROM sources" }, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
 const sql = `SELECT ${transform("crs")} AS geometry FROM sources`;
 metadataDb().prepare("UPDATE layers SET sql = ? WHERE id = ?").run(sql, layer.id);
 const { token } = publishMap(scope(), map.id); resetPublishCache();
 try {
  const view = await getPublishedView(token, Date.now());
  expect(view?.layers[0]).toMatchObject({ render: { error: { code: "sql_rejected", message: "The SQL was not an accepted read-only query." } } });
  expect(metadataDb().prepare("SELECT sql FROM layers WHERE id = ?").get(layer.id)).toEqual({ sql });
  expect(metadataDb().prepare("SELECT publish_token FROM maps WHERE id = ?").get(map.id)).toEqual({ publish_token: token });
 } finally { resetPublishCache(); }
});

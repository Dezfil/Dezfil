import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { upsertTileRecord } from "@/lib/metadata/tiles";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { metadataDb } from "@/lib/metadata/db";
import { inspectGeometry, previewGeometry } from "./service";
import { listProjections } from "./projections";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";
import { lit } from "@/lib/ingest/sql";
import type { GeometryChoice } from "./types";

let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { await cleanupGeometryTest(dir); });
async function preview(select: string, choice: GeometryChoice) {
  const t = await stored(select);
  return previewGeometry(t.name, (await inspectGeometry(t.name)).revision, choice);
}
const cases = [
  ["wkt", "POINT (10 20)", [10, 20]],
  ["wkt", "SRID=3857;POINT (1113194.9079327357 0)", [10, 0]],
  ["geojson", '{"type":"Point","coordinates":[10,20]}', [10, 20]],
  ["wkb", "010100000000000000000024400000000000003440", [10, 20]],
  ["wkb", "0101000020110F00009F476EE86AFC30410000000000000000", [10, 0]],
  ["wkb", "002000000100000F114130FC6AE86E479F0000000000000000", [10, 0]],
] as const;
it("excerpts scalar text without treating a text list as a scalar", async () => {
  const p = await preview("SELECT 'POINT (10 20)' payload, ['one', 'two'] tags", { format: "wkt", columns: ["payload"] });
  expect(p.sample.rows[0].values.tags).toEqual(["one", "two"]);
});
it.each(cases)("preview %s %s decodes independently and keeps unreadable/missing identities", async (format, value, coordinates) => {
  const p = await preview(`SELECT * FROM (VALUES (${lit(value)}), ('bad'), (NULL), (' ')) t(payload)`, { format, columns: ["payload"] });
  expect(p).toMatchObject({ canApply: true, rowCount: 4, unreadableCount: 2, geometryType: "POINT" });
  expect(p.sample.rows.map(r => r.status)).toEqual(["readable", "unreadable", "missing", "unreadable"]);
  expect(p.sample.features.features.map(f => f.id)).toEqual([0, 1, 2, 3]);
  expect(p.sample.features.features[0].geometry).toMatchObject({ type: "Point", coordinates });
  expect(p.sample.features.features.slice(1).map(f => f.geometry)).toEqual([null, null, null]);
});
it("H3 validates the cell before returning its known boundary; Features are not geometries", async () => {
  const p = await preview("SELECT * FROM (VALUES ('8928308280fffff'), ('8928308280ffffe')) t(payload)", { format: "h3", columns: ["payload"] });
  expect(p).toMatchObject({ canApply: true, unreadableCount: 1, geometryType: "POLYGON" });
  expect(p.sample.features.features[0].geometry).toEqual({ type: "Polygon", coordinates: [[[-122.4172,37.775198],[-122.416128,37.77688],[-122.417388,37.778385],[-122.419719,37.778207],[-122.42079,37.776524],[-122.419531,37.77502],[-122.4172,37.775198]]] });
  for (const format of ["h3", "geojson"] as const) {
    await expect(preview(`SELECT 'bad' payload`, { format, columns: ["payload"], epsg: 4326 })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  }
  const feature = await preview(`SELECT ${lit('{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]}}')} payload`, { format: "geojson", columns: ["payload"] });
  expect(feature).toMatchObject({ unreadableCount: 1, geometryType: null, extent: null });
});
it("pairs swap roles and Berlin uses the actual source projection", async () => {
  const sql = "SELECT 391779.25925275::DOUBLE a, 5820072.159211026::DOUBLE b";
  const p = await preview(sql, { format: "pair", columns: ["a", "b"], epsg: 25833 });
  expect(p).toMatchObject({ canApply: true, degreeCompatible: false, unreadableCount: 0 });
  expect(p.extent![0]).toBeCloseTo(13.405, 5); expect(p.extent![1]).toBeCloseTo(52.52, 5);
  expect(p.sample.rows[0].values).toEqual({ a: 391779.25925275, b: 5820072.159211026 });
  const swapped = await preview("SELECT 10 a, 20 b", { format: "pair", columns: ["b", "a"] });
  expect(swapped.extent).toEqual([20, 10, 20, 10]);
  const noProjection = await preview(sql, { format: "pair", columns: ["a", "b"] });
  expect(noProjection).toMatchObject({ canApply: false, issues: [{ code: "projection_required" }], extent: null });
});
it("50 corresponding rows and sampled counts and extent, with no durable side effects", async () => {
  const t = await stored(`SELECT i, CASE WHEN i IN (24, 1001) THEN 'bad' WHEN i=1002 THEN 'POINT (120 70)' ELSE 'POINT (10 20)' END payload FROM range(1003) t(i)`);
  const map=createMap("Preview history");
  const layer=await createLayer(map.id,{name:"Preview tiles",sql:`SELECT TRY(ST_GeomFromText(payload)) geometry FROM ${t.name}`});
  upsertTileRecord({layerId:layer.id,state:"ready",fingerprint:"preview-before",error:null,featureCount:1001,builtAt:"2026-09-01T00:00:00Z"});
  const snapshot=()=>["data_tables","maps","layers","map_history","layer_tiles"].map(table=>metadataDb().prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  const file = path.join(process.env.DEZFIL_DATA_DIR!, t.file), bytes = await readFile(file);
  const inventory = await readdir(path.dirname(file));
  const p = await previewGeometry(t.name, (await inspectGeometry(t.name)).revision, { format: "wkt", columns: ["payload"] });
  expect(p).toMatchObject({ canApply: true, rowCount: 50, unreadableCount: 1, extent: [10, 20, 10, 20] });
  expect(p.sample.rows).toHaveLength(50); expect(p.sample.features.features).toHaveLength(50);
  expect(p.sample.rows[24]).toMatchObject({ index: 24, status: "unreadable", values: { i: "24", payload: "bad" } });
  expect(p.sample.features.features[24]).toMatchObject({ id: 24, geometry: null });
  expect(snapshot()).toEqual(before);
  expect(await readFile(file)).toEqual(bytes); expect(await readdir(path.dirname(file))).toEqual(inventory);
});
it("mixed out-of-range rows are unreadable; entirely projected rows request projection", async () => {
  const mixed = await preview("SELECT * FROM (VALUES (10,20), (181,20), (-180,-90), (180,90), (NULL,20)) t(x,y)", { format: "pair", columns: ["x", "y"] });
  expect(mixed).toMatchObject({ canApply: true, unreadableCount: 1, degreeCompatible: false, extent: [-180,-90,180,90] });
  expect(mixed.sample.rows.map(r => r.status)).toEqual(["readable", "unreadable", "readable", "readable", "missing"]);
  const tail = await preview("SELECT CASE WHEN i=1001 THEN 181 ELSE 10 END x, 20 y FROM range(1002) t(i)", { format: "pair", columns: ["x", "y"] });
  expect(tail).toMatchObject({ canApply: true, rowCount: 50, unreadableCount: 0, degreeCompatible: true });
});
it("declarations win, unknown and mixed declarations refuse, and custom codes resolve", async () => {
  for (const [value, epsg, code] of [
    ["SRID=3857;POINT (10 20)", 4326, "conflicting_crs"],
    ["SRID=unknown;POINT (10 20)", 4326, "unknown_crs"],
    ["SRID=999999999;POINT (10 20)", undefined, "unsupported_projection"],
  ] as const) {
    expect(await preview(`SELECT ${lit(value)} payload`, { format: "wkt", columns: ["payload"], ...(epsg ? { epsg } : {}) })).toMatchObject({ canApply: false, issues: [{ code }] });
  }
  expect(await preview("SELECT * FROM (VALUES ('SRID=4326;POINT (10 20)'), ('SRID=3857;bad')) t(payload)", { format: "wkt", columns: ["payload"] })).toMatchObject({ canApply: false, issues: [{ code: "conflicting_crs" }] });
  const list = await listProjections();
  expect(list.projections.map(p => p.epsg)).toEqual([4326,3857,25832,25833,3035,27700,4269]);
  for (const projection of list.projections) expect((await listProjections(String(projection.epsg))).resolved).toEqual(projection);
  expect((await listProjections("EPSG:31467")).resolved).toEqual({ epsg: 31467, name: "EPSG:31467", unit: null });
  await expect(listProjections("999999999")).rejects.toMatchObject({ code: "geometry_choice_invalid", status: 422 });
});
it("all-bad, empty and transform-failing rows keep exact full outcomes", async () => {
  for (const select of ["SELECT 'bad' payload", "SELECT NULL::VARCHAR payload WHERE false"]) {
    const p = await preview(select, { format: "wkt", columns: ["payload"] });
    expect(p).toMatchObject({ canApply: true, geometryType: null, extent: null, degreeCompatible: null });
    expect(p.unreadableCount).toBe(p.rowCount);
  }
  const p = await preview("SELECT * FROM (VALUES (10,20), (10,1000)) t(x,y)", { format: "pair", columns: ["x", "y"], epsg: 4269 });
  expect(p).toMatchObject({ canApply: true, unreadableCount: 1 });
});

it("field round: long lines have a light preview without changing sampled bounds or saved values", async () => {
  const line = "LINESTRING (" + Array.from({ length: 10000 }, (_, i) => `${10 + i * 0.00001} ${20 + Math.sin(i * 0.001) * 0.001}`).join(", ") + ")";
  const t = await stored(`SELECT i, ${lit(line)} payload FROM range(50) t(i)`);
  const p = await previewGeometry(t.name, (await inspectGeometry(t.name)).revision, { format: "wkt", columns: ["payload"] });
  expect(p).toMatchObject({ rowCount: 50, unreadableCount: 0, degreeCompatible: true });
  expect(p.sample.rows.every(r => r.status === "readable")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(100000);
  expect(String(p.sample.rows[0].values.payload)).toMatch(/…$/);
  expect(p.sample.features.features[0].geometry).toMatchObject({ type: "LineString" });
  expect(p.extent?.[2]).toBeCloseTo(10.09999);
});

it("field round: CRS declarations beyond the preview sample still govern the source", async () => {
  for (const tail of ["SRID=3857;POINT (10 20)", "SRID=unknown;POINT (10 20)"]) {
    const p = await preview(`SELECT CASE WHEN i=1001 THEN ${lit(tail)} ELSE 'SRID=4326;POINT (10 20)' END payload FROM range(1002) t(i)`, {format:"wkt", columns:["payload"]});
    expect(p.canApply).toBe(false);
    expect(p.issues[0].code).toBe(tail.includes("unknown") ? "unknown_crs" : "conflicting_crs");
    expect(p.rowCount).toBe(50);
  }
});

it.each(["POINT EMPTY", "LINESTRING EMPTY", "POLYGON EMPTY", "GEOMETRYCOLLECTION EMPTY"])("field round: simplifying %s keeps its readable row identity", async wkt => {
  const p = await preview(`SELECT ${lit(wkt)} payload`, { format:"wkt", columns:["payload"] });
  expect(p).toMatchObject({ canApply:true, unreadableCount:0, extent:null });
  expect(p.sample.rows[0].status).toBe("readable");
  expect(p.sample.features.features[0].geometry).not.toBeNull();
});

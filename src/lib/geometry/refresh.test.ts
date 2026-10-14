import { readDocumentRevision as readEditRevision } from "@/lib/metadata/revisions";
import { testAccountScope } from "@/lib/test-support/accounts";
import { createMap } from "@/lib/map-service";
import { createLayer } from "@/lib/layer-service";
import { getTileRecord, upsertTileRecord } from "@/lib/metadata/tiles";
import { tileArchivePath } from "@/lib/tiles/paths";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { withConnection } from "@/lib/duckdb";
import { inspectTable } from "@/lib/table-service";
import { importFromUrl } from "@/lib/ingest/remote";
import { refreshTable } from "@/lib/ingest/refresh";
import { retirementsSettled } from "@/lib/ingest/retire";
import { lit } from "@/lib/ingest/sql";
import { buildZip } from "../../../test-support/zip";
import { clearGeometry, inspectGeometry, setGeometry } from "./service";
import { geometryRevision } from "./read";
import { cleanupGeometryTest, setupGeometryTest } from "@/lib/test-support/geometry";

let remote: string | Buffer, dir: string;
const requests = vi.fn();
vi.mock("@/lib/net/remote-fetch", () => ({ openRemote: vi.fn(async () => {
  requests(); const { Readable } = await import("node:stream");
  return { statusCode: 200, headers: { "content-type": "application/octet-stream" }, body: Readable.from([remote]) };
}) }));
beforeEach(async () => { dir = await setupGeometryTest(); requests.mockClear(); });
afterEach(async () => { await cleanupGeometryTest(dir); });
it("manual URL choice survives restart and overrides fresh automatic recognition before WKT is consumed", async () => {
  remote = 'payload,other,x,y\n"POINT (1 2)","POINT (3 4)",391779.25925275,5820072.159211026\n';
  const t = (await importFromUrl(testAccountScope(), "https://fixture.test/data.csv")).tables[0];
  await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "pair", columns: ["x", "y"], epsg: 25833 });
  closeMetadataDb();
  remote = 'wkt,x,y\n"POINT (80 40)",500000,0\n"POINT (90 50)",NaN,1\n';
  const refreshed = await refreshTable(testAccountScope(), t.name);
  expect(refreshed).toMatchObject({ id: t.id, rowCount: 2, geometryType: "POINT", crsAssumed: false, sourceParams: t.sourceParams,
    geometryRecord: { signal: "manual", columns: ["x", "y"], unreadableCount: 1, crs: { srid: 25833 } } });
  expect(refreshed.importedAt).not.toBe(t.importedAt);
  expect(await inspectGeometry(testAccountScope(), t.name)).toMatchObject({ mode: "set", currentChoice: { format: "pair", columns: ["x", "y"], epsg: 25833 } });
  const rows = (await inspectTable(testAccountScope(), t.name)).preview;
  expect(rows[0]).toMatchObject({ wkt: "POINT (80 40)", x: 500000, y: "0" });
  expect(Number(String(rows[0][refreshed.geometryColumn!]).match(/-?\d+(?:\.\d+)?/)![0])).toBeCloseTo(15, 8);
  expect(rows[1][refreshed.geometryColumn!]).toBeNull();
});
it("a consumed named-WKT correction replays its historical source name on fresh bytes", async () => {
  remote = 'wkt,label\n"POINT (10 20)",a\n';
  const t = (await importFromUrl(testAccountScope(), "https://fixture.test/named.csv")).tables[0];
  await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkt", columns: [t.geometryColumn!], epsg: 3857 });
  remote = 'wkt,label\n"POINT (1113194.9079327357 0)",b\n';
  const next = await refreshTable(testAccountScope(), t.name);
  expect(next.geometryRecord).toMatchObject({ signal: "manual", columns: ["wkt"], crs: { srid: 3857 } });
  const inspected = await inspectTable(testAccountScope(), t.name);
  expect(inspected.preview[0]).toMatchObject({ wkt: "POINT (1113194.9079327357 0)", [next.geometryColumn!]: "POINT (10 0)" });
});
it("clear removes the override; refresh records fresh automatic recognition and unmodified mode", async () => {
  remote = 'payload,x,y\n"POINT (1 2)",10,20\n';
  const t = (await importFromUrl(testAccountScope(), "https://fixture.test/clear.csv")).tables[0];
  const set = await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "pair", columns: ["y", "x"] });
  const clear = await clearGeometry(testAccountScope(), t.name, set.revision);
  expect(clear).toMatchObject({ mode: "cleared", currentChoice: null, table: { geometryRecord: null } });
  remote = 'new_shape,label\n"LINESTRING (30 40, 31 41)",new\n';
  const refreshed = await refreshTable(testAccountScope(), t.name);
  expect(refreshed).toMatchObject({ geometryType: "LINESTRING", geometryRecord: { signal: "content", columns: ["new_shape"] } });
  expect(await inspectGeometry(testAccountScope(), t.name)).toMatchObject({ mode: "unmodified", currentChoice: { format: "wkt", columns: ["new_shape"] } });
  // This currentChoice is reconstructable automatic evidence, not a saved
  // manual override: a second refresh must recognize a different schema.
  remote = 'other,label\n"POINT (50 60)",newer\n';
  expect(await refreshTable(testAccountScope(), t.name)).toMatchObject({ geometryRecord: { signal: "content", columns: ["other"] } });
});
it.each(["column", "publication"])("%s failure keeps old artifact, manual choice and record together", async failure => {
  remote = 'payload,x,y\n"POINT (1 2)",10,20\n';
  const t = (await importFromUrl(testAccountScope(), "https://fixture.test/failure.csv")).tables[0];
  await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "pair", columns: ["y", "x"] });
  await retirementsSettled();
  const map=createMap(testAccountScope(), "Retained tiles"),layer=await createLayer(testAccountScope(), map.id,{name:"Tiles",sql:`SELECT geometry FROM ${t.name}`}, { expectedRevision: readEditRevision({ kind: "map", id: map.id })?.editRevision });
  upsertTileRecord({layerId:layer.id,state:"ready",fingerprint:"before-failed-refresh",error:null,featureCount:1,builtAt:"2026-09-01T00:00:00Z"});
  const tileFile=tileArchivePath(layer.id);await mkdir(path.dirname(tileFile),{recursive:true});await writeFile(tileFile,"existing archive bytes");
  const tileBefore=getTileRecord(layer.id);
  const before = getTableByName(t.name), evidence = await inspectGeometry(testAccountScope(), t.name);
  const inventory = await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables"));
  remote = failure === "column" ? 'payload,a,b\n"POINT (3 4)",30,40\n' : 'payload,x,y\n"POINT (3 4)",30,40\n';
  if (failure === "publication") metadataDb().exec("CREATE TRIGGER fail_refresh BEFORE UPDATE ON data_tables BEGIN SELECT RAISE(ABORT, 'seeded publication failure'); END");
  await expect(refreshTable(testAccountScope(), t.name)).rejects.toThrow();
  expect(getTableByName(t.name)).toEqual(before); expect(await inspectGeometry(testAccountScope(), t.name)).toEqual(evidence);
  expect(getTileRecord(layer.id)).toEqual(tileBefore);expect(await readFile(tileFile,"utf8")).toBe("existing archive bytes");
  expect(await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables"))).toEqual(inventory);
});
async function shapeGroup(x: number, y: number) {
  const members = [];
  for (const name of ["alpha", "beta"]) {
    const folder = path.join(dir, name); await rm(folder, { recursive: true, force: true }); await mkdir(folder);
    await withConnection(conn => conn.run(`COPY (SELECT ST_Point(${x},${y}) geom, 'a' AS label) TO ${lit(path.join(folder, name+".shp"))} (FORMAT GDAL, DRIVER 'ESRI Shapefile', SRS 'EPSG:25833')`));
    for (const file of await readdir(folder)) if (!file.endsWith(".prj")) members.push({ name: `${name}/${file}`, data: await readFile(path.join(folder,file)) });
  }
  return buildZip(members);
}
it("container members replay separate native choices in one download and atomic group commit", async () => {
  remote = await shapeGroup(391779.25925275,5820072.159211026);
  const tables = (await importFromUrl(testAccountScope(), "https://fixture.test/group.zip")).tables;
  expect(tables).toHaveLength(2);
  for (let i=0;i<2;i++) await setGeometry(testAccountScope(), tables[i].name, geometryRevision(tables[i]), { format: "wkb", columns: [tables[i].geometryColumn!], epsg: i === 0 ? 25833 : 25832 });
  closeMetadataDb(); requests.mockClear();
  remote = await shapeGroup(500000,0);
  const next = await refreshTable(testAccountScope(), tables[0].name);
  expect(requests).toHaveBeenCalledTimes(1);
  for (let i=0;i<2;i++) {
    const t = getTableByName(tables[i].name)!;
    expect(t.importedAt).toBe(next.importedAt);
    expect(t.geometryRecord).toMatchObject({ signal: "manual", crs: { srid: i === 0 ? 25833 : 25832 } });
    const shape = String((await inspectTable(testAccountScope(), t.name)).preview[0][t.geometryColumn!]);
    expect(Number(shape.match(/-?\d+(?:\.\d+)?/)![0])).toBeCloseTo(i === 0 ? 15 : 9, 8);
  }
  await retirementsSettled();
  const before = tables.map(t => getTableByName(t.name));
  const inventory = await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables"));
  metadataDb().exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON data_tables WHEN OLD.name = ${lit(tables[1].name)} BEGIN SELECT RAISE(ABORT, 'second member publication failure'); END`);
  await expect(refreshTable(testAccountScope(), tables[0].name)).rejects.toThrow("second member publication failure");
  expect(tables.map(t => getTableByName(t.name))).toEqual(before);
  expect(await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables"))).toEqual(inventory);
});

it("a bad numeric source value remains an unreadable row when CSV inference widens its type", async () => {
  remote = 'payload,x,y\n"POINT (1 2)",10,20\n';
  const t = (await importFromUrl(testAccountScope(), "https://fixture.test/bad-pair.csv")).tables[0];
  await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "pair", columns: ["x", "y"] });
  remote = 'x,y\n30,40\nbroken,50\n,60\n';
  const next = await refreshTable(testAccountScope(), t.name);
  expect(next).toMatchObject({ rowCount: 3, geometryRecord: { signal: "manual", unreadableCount: 1 } });
  expect((await inspectTable(testAccountScope(), t.name)).preview.map(r => r[next.geometryColumn!])).toEqual(["POINT (30 40)", null, null]);
  expect((await inspectTable(testAccountScope(), t.name)).preview.map(r => r.x)).toEqual(["30", "broken", null]);
});

it("native GeoParquet replay uses fresh raw bytes and refuses a newly declared conflicting CRS", async () => {
  const file = path.join(dir, "remote.parquet");
  await withConnection(conn => conn.run(`COPY (SELECT ST_AsWKB(ST_Point(391779.25925275,5820072.159211026)) geom) TO ${lit(file)} (FORMAT PARQUET)`));
  remote = await readFile(file); await rm(file);
  const t = (await importFromUrl(testAccountScope(), "https://fixture.test/native.parquet")).tables[0];
  await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkb", columns: [t.geometryColumn!], epsg: 25833 });
  await withConnection(conn => conn.run(`COPY (SELECT ST_AsWKB(ST_Point(500000,0)) geom) TO ${lit(file)} (FORMAT PARQUET)`));
  remote = await readFile(file); await rm(file);
  const fresh = await refreshTable(testAccountScope(), t.name);
  expect(fresh.geometryRecord).toMatchObject({ signal: "manual", crs: { srid: 25833 } });
  expect(Number(String((await inspectTable(testAccountScope(), t.name)).preview[0][fresh.geometryColumn!]).match(/-?\d+(?:\.\d+)?/)![0])).toBeCloseTo(15, 8);
  // Typed GeoParquet without an explicit CRS declares CRS84 by the format
  // contract, unlike its earlier bare WKB BLOB source.
  await withConnection(conn => conn.run(`COPY (SELECT ST_Point(10,20) geom) TO ${lit(file)} (FORMAT PARQUET)`));
  remote = await readFile(file);
  await expect(refreshTable(testAccountScope(), t.name)).rejects.toMatchObject({ code: "geometry_choice_invalid", extra: { issues: [{ code: "conflicting_crs" }] } });
  expect(getTableByName(t.name)).toEqual(fresh);
});

it.each(["", "\n\r\n", " \t\n  "])("refuses empty fresh CSV content before replaying a stored geometry choice (%j)", async csv => {
  remote = 'payload,x,y\n"POINT (1 2)",10,20\n';
  const table = (await importFromUrl(testAccountScope(), "https://fixture.test/empty.csv")).tables[0];
  await setGeometry(testAccountScope(), table.name, geometryRevision(table), { format: "pair", columns: ["x", "y"] });
  await retirementsSettled();
  const before = getTableByName(table.name)!;
  const geometry = await inspectGeometry(testAccountScope(), table.name);
  const tablesDir = path.join(process.env.DEZFIL_DATA_DIR!, "tables");
  const inventory = await readdir(tablesDir);
  const artifact = await readFile(path.join(process.env.DEZFIL_DATA_DIR!, before.file));

  remote = csv;
  await expect(refreshTable(testAccountScope(), table.name)).rejects.toMatchObject({
    code: "malformed_file", status: 422,
    message: "The file could not be read as csv: The CSV contains no header or data.",
  });
  expect(getTableByName(table.name)).toEqual(before);
  expect(await inspectGeometry(testAccountScope(), table.name)).toEqual(geometry);
  expect(await readdir(tablesDir)).toEqual(inventory);
  expect(await readFile(path.join(process.env.DEZFIL_DATA_DIR!, before.file))).toEqual(artifact);
});

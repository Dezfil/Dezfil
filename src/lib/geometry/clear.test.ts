import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, expect, it } from "vitest";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { inspectTable } from "@/lib/table-service";
import { metadataDb } from "@/lib/metadata/db";
import { withConnection } from "@/lib/duckdb";
import { createMap, updateMap, undoChange, mapHistory } from "@/lib/map-service";
import { createLayer, requireLayer } from "@/lib/layer-service";
import { ingestFile } from "@/lib/ingest/ingest";
import { ingestSource } from "@/lib/ingest/gdal-formats";
import { lit } from "@/lib/ingest/sql";
import { buildZip } from "../../../test-support/zip";
import { inspectGeometry, setGeometry, clearGeometry, previewGeometry } from "./service";
import { geometryRevision } from "./read";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";

let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { await cleanupGeometryTest(dir); });
it("clear keeps every source and identity, repeats as a no-op and permits reapply", async () => {
  const t = await stored("SELECT 'POINT (10 20)' payload, 30 x, 40 y");
  const original = await inspectTable(t.name);
  const set = await setGeometry(t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] });
  const clear = await clearGeometry(t.name, set.revision);
  expect(clear).toMatchObject({ mode: "cleared", currentChoice: null, extent: null, table: { id: t.id, name: t.name, rowCount: 1, geometryColumn: null, geometryType: null, geometryRecord: null, crsAssumed: false, importedAt: t.importedAt } });
  expect((await inspectTable(t.name)).columns).toEqual(original.columns);
  expect((await inspectTable(t.name)).preview).toEqual(original.preview);
  expect(await clearGeometry(t.name, clear.revision)).toEqual(clear);
  expect((await inspectGeometry(t.name)).candidates.length).toBeGreaterThan(0);
  const again = await setGeometry(t.name, clear.revision, { format: "pair", columns: ["y", "x"], epsg: 4326 });
  expect(again.extent).toEqual([40, 30, 40, 30]);
});
it("set, change, preview and clear preserve both undo and redo plus authored layer SQL/style", async () => {
  const t = await stored("SELECT 'POINT (10 20)' payload, 30 x, 40 y");
  const map = createMap(testAccountScope(), "Geometry map");
  const layer = await createLayer(map.id, { name: "Points", sql: `SELECT ST_GeomFromText(payload) geometry FROM ${t.name}` });
  updateMap(map.id, { name: "Renamed", basemap: "dark" });
  await undoChange(map.id);
  expect(mapHistory(map.id)).toEqual({ canUndo: true, canRedo: true });
  const history = metadataDb().prepare("SELECT * FROM map_history ORDER BY seq").all();
  const beforeLayer = requireLayer(layer.id);
  const beforeMap = metadataDb().prepare("SELECT * FROM maps WHERE id = ?").get(map.id);
  const first = await setGeometry(t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] });
  await previewGeometry(t.name, first.revision, { format: "pair", columns: ["x", "y"] });
  const change = await setGeometry(t.name, first.revision, { format: "pair", columns: ["x", "y"] });
  await clearGeometry(t.name, change.revision);
  expect(metadataDb().prepare("SELECT * FROM map_history ORDER BY seq").all()).toEqual(history);
  expect(metadataDb().prepare("SELECT * FROM maps WHERE id = ?").get(map.id)).toEqual(beforeMap);
  expect(requireLayer(layer.id)).toEqual(beforeLayer);
  expect(mapHistory(map.id)).toEqual({ canUndo: true, canRedo: true });
});
it.each(["consumed-wkt", "assumed-parquet", "shapefile-no-prj"])("%s accepts its first projection correction, then explains second-change and clear refusal", async kind => {
  let t;
  if (kind === "consumed-wkt") {
    const csv = path.join(dir, "named.csv"); await writeFile(csv, 'wkt,label\n"POINT (10 20)",a\n');
    t = await ingestFile(testAccountScope(), csv, "named.csv");
  } else if (kind === "assumed-parquet") {
    const file = path.join(dir, "assumed.parquet");
    await withConnection(conn => conn.run(`COPY (SELECT ST_AsWKB(ST_Point(391779.25925275,5820072.159211026)) geom, 'a' AS label) TO ${lit(file)} (FORMAT PARQUET)`));
    t = await ingestFile(testAccountScope(), file, "assumed.parquet");
  } else {
    const folder = path.join(dir, "shape"); await mkdir(folder);
    await withConnection(conn => conn.run(`COPY (SELECT ST_Point(391779.25925275,5820072.159211026) geom, 'a' AS label) TO ${lit(path.join(folder, "points.shp"))} (FORMAT GDAL, DRIVER 'ESRI Shapefile', SRS 'EPSG:25833')`));
    const members = [];
    for (const file of await readdir(folder)) if (!file.endsWith(".prj")) members.push({ name: file, data: await readFile(path.join(folder,file)) });
    const zip = path.join(dir, "noprj.zip"); await writeFile(zip, buildZip(members));
    t = (await ingestSource(testAccountScope(), zip, "noprj.zip")).tables[0];
  }
  expect(t.crsAssumed).toBe(true);
  const choice = { format: kind === "consumed-wkt" ? "wkt" : "wkb", columns: [t.geometryColumn!], epsg: kind === "consumed-wkt" ? 3857 : 25833 } as const;
  const firstPreview = await previewGeometry(t.name, geometryRevision(t), choice);
  expect(firstPreview.canApply).toBe(true);
  const applied = await setGeometry(t.name, geometryRevision(t), choice);
  expect(applied.table.geometryColumn).toBe(t.geometryColumn);
  expect(applied.table).toMatchObject({ crsAssumed: false, geometryRecord: { signal: "manual", crs: { stance: "declared", srid: choice.epsg } } });
  const expected = kind === "consumed-wkt" ? [0.0000898315284,0.0001796630568] : [13.405,52.52];
  expect(applied.extent![0]).toBeCloseTo(expected[0], kind === "consumed-wkt" ? 10 : 5);
  expect(applied.extent![1]).toBeCloseTo(expected[1], kind === "consumed-wkt" ? 10 : 5);
  expect((await inspectGeometry(t.name)).currentChoice).toBeNull();
  await expect(setGeometry(t.name, applied.revision, choice)).rejects.toMatchObject({ code: "geometry_choice_invalid", extra: { issues: [{ code: "source_unavailable", message: expect.stringMatching(/source/) }] } });
  await expect(clearGeometry(t.name, applied.revision)).rejects.toMatchObject({ code: "geometry_choice_invalid", extra: { issues: [{ code: "source_unavailable", message: expect.stringMatching(/native|consumed/) }] } });
});
it("clear also refuses an unmodified native geometry without removing it", async () => {
  const t = await stored("SELECT ST_Point(10,20) geom, 'a' AS label", { geometryColumn: "geom", geometryType: "POINT", crsAssumed: true });
  await expect(clearGeometry(t.name, geometryRevision(t))).rejects.toMatchObject({ code: "geometry_choice_invalid", status: 422 });
  expect((await inspectTable(t.name)).geometryColumn).toBe("geom");
});
it("declared native geometry explains replacement refusal without claiming source loss", async () => {
  const t = await stored("SELECT ST_Point(10,20) geom, 'POINT (30 40)' payload", { geometryColumn: "geom", geometryType: "POINT", crsAssumed: false });
  const before = await inspectTable(t.name);
  const choice = { format: "wkt", columns: ["payload"] } as const;
  const message = "This dataset's geometry has a declared CRS. It cannot be replaced here.";
  for (const operation of [previewGeometry, setGeometry]) {
    await expect(operation(t.name, geometryRevision(t), choice)).rejects.toMatchObject({ code: "geometry_choice_invalid", status: 422, message, extra: { issues: [{ code: "source_unavailable", message }] } });
    expect(await inspectTable(t.name)).toEqual(before);
  }
});
it("consumed declared EWKT explains replacement refusal with neutral CRS copy", async () => {
  const csv = path.join(dir, "declared.csv");
  await writeFile(csv, 'wkt,label\n"SRID=3857;POINT (1113194.9079327357 0)",a\n');
  const t = await ingestFile(testAccountScope(), csv, "declared.csv");
  expect(t).toMatchObject({ crsAssumed: false, geometryRecord: { columns: ["wkt"], crs: { stance: "declared", srid: 3857 } } });
  const before = await inspectTable(t.name);
  expect(before.columns.map(column => column.name)).not.toContain("wkt");
  expect((await inspectGeometry(t.name)).currentChoice).toBeNull();
  const choice = { format: "wkt", columns: [t.geometryColumn!], epsg: 4326 } as const;
  const message = "This dataset's geometry has a declared CRS. It cannot be replaced here.";
  for (const operation of [previewGeometry, setGeometry]) {
    await expect(operation(t.name, geometryRevision(t), choice)).rejects.toMatchObject({ code: "geometry_choice_invalid", status: 422, message, extra: { issues: [{ code: "source_unavailable", message }] } });
    expect(await inspectTable(t.name)).toEqual(before);
  }
});

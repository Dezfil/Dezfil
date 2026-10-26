import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { closeMetadataDb, metadataDb } from "@/lib/metadata/db";
import { getTableByName } from "@/lib/metadata/tables";
import { createProject, fileTable } from "@/lib/metadata/projects";
import { inspectTable } from "@/lib/table-service";
import { ingestFile } from "@/lib/ingest/ingest";
import { lit } from "@/lib/ingest/sql";
import { inspectGeometry, setGeometry, previewGeometry } from "./service";
import { geometryRevision } from "./read";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";
import type { GeometryChoice } from "./types";
import { withConnection } from "@/lib/duckdb";
import { ingestScratchDir } from "@/lib/ingest/scratch";

const fetchSource = vi.fn<(...args: unknown[]) => never>(() => { throw new Error("source must not be fetched"); });
vi.mock("@/lib/ingest/remote", () => ({ resolveRemoteSource: (...args: unknown[]) => fetchSource(...args) }));
let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { await cleanupGeometryTest(dir); vi.clearAllMocks(); });
async function apply(name: string, choice: GeometryChoice) { return setGeometry(testAccountScope(), name, (await inspectGeometry(testAccountScope(), name)).revision, choice); }
// Writing 50,000 long lines ran past 20 s on a busy hosted runner.
it("writes long lines with bounded memory and no engine spill directory, then removes its stage", async () => {
  const t = await stored(`SELECT i, 'LINESTRING (' || array_to_string(list_transform(range(160), p ->
    printf('%.7f %.7f', 8 + i * 0.000001 + p * 0.00002, 50 + sin(p * 0.1 + i) * 0.001)), ', ') || ')' payload FROM range(50000) t(i)`);
  const source = path.join(process.env.DEZFIL_DATA_DIR!, t.file), grouped = path.join(dir, "grouped.parquet");
  await withConnection(conn => conn.run(`COPY (SELECT * FROM read_parquet(${lit(source)})) TO ${lit(grouped)} (FORMAT PARQUET, ROW_GROUP_SIZE 2048)`));
  await rename(grouped, source);
  await withConnection(async conn => {
    await conn.run("SET memory_limit='128MB'");
    await conn.run("SET threads=1");
    await conn.run("SET temp_directory=''");
  });
  const result = await setGeometry(testAccountScope(), t.name, geometryRevision(t), { format: "wkt", columns: ["payload"] });
  expect(result.table).toMatchObject({ rowCount: 50000, geometryType: "LINESTRING", geometryRecord: { unreadableCount: 0 } });
  expect(await readdir(ingestScratchDir())).toEqual([]);
  const projected = await stored("SELECT 'POINT (1000 1000)' payload");
  await expect(setGeometry(testAccountScope(), projected.name, geometryRevision(projected), { format: "wkt", columns: ["payload"] })).rejects.toMatchObject({ code: "geometry_choice_invalid" });
  expect(await readdir(ingestScratchDir())).toEqual([]);
}, 60_000);
it.each(["upload", "url"] as const)("legacy %s trajectories apply offline, keep all originals and project identity", async source => {
  const csv = path.join(dir, "gone.csv"); await writeFile(csv, await readFile("src/lib/ingest/fixtures/trajectories.csv"));
  const table = await stored(`SELECT * FROM read_csv(${lit(csv)})`, { source, sourceParams: source === "url" ? { url: "https://gone.test/route.csv" } : null });
  await rm(csv); const project = createProject(testAccountScope(), { name: "Geometry" }); fileTable(table.id, project.id);
  const before = await inspectTable(testAccountScope(), table.name);
  const result = await setGeometry(testAccountScope(), table.name, geometryRevision(table), { format: "wkt", columns: ["column01"] });
  expect(result).toMatchObject({ mode: "set", table: { id: table.id, name: table.name, rowCount: 3, geometryType: "LINESTRING", source, sourceParams: table.sourceParams, importedAt: table.importedAt, createdAt: table.createdAt, projectIds: [project.id], geometryRecord: { signal: "manual", rule: "manual", columns: ["column01"], unreadableCount: 0 } } });
  const after = await inspectTable(testAccountScope(), table.name);
  expect(after.columns.slice(0, before.columns.length)).toEqual(before.columns);
  for (let i=0; i<before.preview.length; i++) expect(after.preview[i]).toMatchObject(before.preview[i]);
  expect(after.preview[0][result.table.geometryColumn!]).toBe("LINESTRING (8.5717 50.0492, 8.572175 50.0492)");
  expect(fetchSource).not.toHaveBeenCalled();
});
it("change uses retained inputs, keeps a collision-safe output, and survives reopen", async () => {
  const t = await stored("SELECT 'original' geometry, 'untouched' geometry_2, 391779.25925275::DOUBLE x, 5820072.159211026::DOUBLE y, 'LINESTRING (1 2, 3 4)' payload");
  const first = await apply(t.name, { format: "wkt", columns: ["payload"] });
  expect(first.table.geometryColumn).not.toBe("geometry"); expect(first.table.geometryColumn).not.toBe("geometry_2");
  expect(first.table).toMatchObject({ crsAssumed: true, geometryType: "LINESTRING" });
  const second = await apply(t.name, { format: "pair", columns: ["x", "y"], epsg: 25833 });
  expect(second.table.geometryColumn).toBe(first.table.geometryColumn);
  expect(second.extent![0]).toBeCloseTo(13.405, 5); expect(second.extent![1]).toBeCloseTo(52.52, 5);
  expect(second.table).toMatchObject({ crsAssumed: false, geometryType: "POINT", importedAt: t.importedAt, geometryRecord: { crs: { stance: "declared", srid: 25833 } } });
  const third = await apply(t.name, { format: "pair", columns: ["x", "y"], epsg: 25832 });
  expect(third.extent![0]).toBeCloseTo(7.405, 5);
  const inspected = await inspectTable(testAccountScope(), t.name);
  expect(inspected.columns).toHaveLength(6);
  expect(inspected.preview[0]).toMatchObject({ geometry: "original", geometry_2: "untouched", x: 391779.25925275, y: 5820072.159211026 });
  const shape = String(inspected.preview[0][third.table.geometryColumn!]).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(shape[0]).toBeCloseTo(7.405, 5); expect(shape[1]).toBeCloseTo(52.52, 5);
  closeMetadataDb();
  expect(await inspectGeometry(testAccountScope(), t.name)).toMatchObject({ mode: "set", currentChoice: { format: "pair", columns: ["x", "y"], epsg: 25832 }, geometryRecord: third.table.geometryRecord });
});
it.each([
  ["wkt", "SRID=3857;POINT (1113194.9079327357 0)", "POINT (10 0)"],
  ["geojson", '{"type":"Point","coordinates":[10,20]}', "POINT (10 20)"],
  ["wkb", "0101000020110F00009F476EE86AFC30410000000000000000", "POINT (10 0)"],
  ["wkb", "002000000100000F114130FC6AE86E479F0000000000000000", "POINT (10 0)"],
  ["h3", "8928308280fffff", "POLYGON ((-122.4172 37.775198"],
] as const)("%s applies tolerant rows and stores the expected geometry", async (format, value, expected) => {
  const t = await stored(`SELECT * FROM (VALUES (${lit(value)}), ('bad'), (NULL), (' ')) t(payload)`);
  const result = await apply(t.name, { format, columns: ["payload"] });
  expect(result.table).toMatchObject({ rowCount: 4, geometryRecord: { unreadableCount: 2 } });
  const inspection = await inspectTable(testAccountScope(), t.name);
  const values = inspection.preview.map(r => r[result.table.geometryColumn!]);
  expect(String(values[0])).toContain(expected); expect(values.slice(1)).toEqual([null, null, null]);
});
it.each([false, true])("all-bad and empty applied output retains geometry identity (empty=%s)", async empty => {
  const t = await stored(`SELECT 'bad' payload ${empty ? "WHERE false" : ""}`);
  const result = await apply(t.name, { format: "wkt", columns: ["payload"] });
  expect(result.table.geometryColumn).toBeTruthy();
  expect(result).toMatchObject({ extent: null, table: { geometryType: null, rowCount: empty ? 0 : 1, geometryRecord: { unreadableCount: empty ? 0 : 1 } } });
  expect((await inspectTable(testAccountScope(), t.name)).columns.some(c => c.type.startsWith("GEOMETRY"))).toBe(true);
});
it("automatic retained source is replaceable but its generated output is not source text", async () => {
  const csv = path.join(dir, "content.csv"); await writeFile(csv, 'payload,x,y\n"POINT (10 20)",30,40\n');
  const t = await ingestFile(testAccountScope(), csv, "content.csv");
  const result = await apply(t.name, { format: "pair", columns: ["y", "x"], epsg: 4326 });
  expect(result.table.geometryColumn).toBe(t.geometryColumn);
  expect(result.extent).toEqual([40, 30, 40, 30]);
  await expect(apply(t.name, { format: "wkt", columns: [t.geometryColumn!] })).rejects.toMatchObject({ code: "geometry_choice_invalid" });
});
it("a failed publication keeps artifact, record, choice and file inventory", async () => {
  const t = await stored("SELECT 'POINT (10 20)' payload");
  await apply(t.name, { format: "wkt", columns: ["payload"] });
  const before = getTableByName(t.name)!; const evidence = await inspectGeometry(testAccountScope(), t.name);
  const inventory = await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables"));
  metadataDb().exec("CREATE TRIGGER fail_geometry BEFORE UPDATE ON data_tables BEGIN SELECT RAISE(ABORT, 'seeded publication failure'); END");
  await expect(apply(t.name, { format: "wkt", columns: ["payload"], epsg: 4326 })).rejects.toThrow("seeded publication failure");
  expect(getTableByName(t.name)).toEqual(before); expect(await inspectGeometry(testAccountScope(), t.name)).toEqual(evidence);
  expect(await readdir(path.join(process.env.DEZFIL_DATA_DIR!, "tables"))).toEqual(inventory);
});
it("invalid projection and stale revision do not publish", async () => {
  const t = await stored("SELECT 500000 x, 5800000 y");
  const choice = { format: "pair", columns: ["x", "y"] } as const;
  const p = await previewGeometry(testAccountScope(), t.name, geometryRevision(t), choice);
  expect(p.canApply).toBe(false);
  await expect(setGeometry(testAccountScope(), t.name, geometryRevision(t), choice)).rejects.toMatchObject({ code: "geometry_choice_invalid", status: 422 });
  await expect(setGeometry(testAccountScope(), t.name, "stale", choice)).rejects.toMatchObject({ code: "input_changed", status: 409 });
  expect(getTableByName(t.name)).toEqual(t);
});

it.each(["wkt","wkb","geojson","h3","pair"] as const)("%s keeps both all-unreadable and zero-row geometry identities",async format=>{
  for(const empty of [false,true]) {
    const t=await stored((format==="pair"?"SELECT 'NaN'::DOUBLE x, 10::DOUBLE y":"SELECT ' '::VARCHAR payload")+(empty?" WHERE false":""));
    const result=await apply(t.name,{format,columns:format==="pair"?["x","y"]:["payload"],...(format==="pair"?{epsg:3857}:{})});
    expect(result.table.geometryColumn).toBeTruthy();
    expect(result).toMatchObject({extent:null,table:{geometryType:null,rowCount:empty?0:1,geometryRecord:{unreadableCount:empty?0:1}}});
    expect((await inspectTable(testAccountScope(), t.name)).columns.some(c=>c.type.startsWith("GEOMETRY"))).toBe(true);
  }
});

it("field round: sampled preview leaves full unreadable counts, geometry class and extent to Apply", async () => {
  const t = await stored(`SELECT i, CASE WHEN i=75 THEN 'bad' WHEN i=80 THEN 'POINT (181 10)'
    WHEN i=1001 THEN 'LINESTRING (100 50, 120 70)' ELSE 'POINT (10 20)' END payload FROM range(1002) t(i)`);
  const choice = { format: "wkt", columns: ["payload"] } as const;
  const preview = await previewGeometry(testAccountScope(), t.name, geometryRevision(t), choice);
  expect(preview).toMatchObject({ rowCount: 50, unreadableCount: 0, extent: [10,20,10,20], geometryType: "POINT", degreeCompatible: true });
  const result = await setGeometry(testAccountScope(), t.name, geometryRevision(t), choice);
  expect(result).toMatchObject({ extent: [10,20,120,70], table: { rowCount: 1002, geometryType: "POINT+LINESTRING", geometryRecord: { unreadableCount: 2 } } });
});

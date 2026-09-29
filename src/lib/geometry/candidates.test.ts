import { testAccountScope } from "@/lib/test-support/accounts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { getTableByName } from "@/lib/metadata/tables";
import { withConnection } from "@/lib/duckdb";
import { ingestFile } from "@/lib/ingest/ingest";
import { lit } from "@/lib/ingest/sql";
import { inspectGeometry } from "./service";
import { cleanupGeometryTest, setupGeometryTest, stored } from "@/lib/test-support/geometry";

const fetchSource = vi.fn<(...args: unknown[]) => never>(() => { throw new Error("source must not be fetched"); });
vi.mock("@/lib/ingest/remote", () => ({ resolveRemoteSource: (...args: unknown[]) => fetchSource(...args) }));
let dir: string;
beforeEach(async () => { dir = await setupGeometryTest(); });
afterEach(async () => { await cleanupGeometryTest(dir); vi.clearAllMocks(); });

it.each(["upload", "url"] as const)("legacy %s trajectories detect on stored values without a surviving source", async source => {
  const csv = path.join(dir, "trajectories.csv");
  await writeFile(csv, await readFile("src/lib/ingest/fixtures/trajectories.csv"));
  const table = await stored(`SELECT * FROM read_csv(${lit(csv)})`, { source, sourceParams: source === "url" ? { url: "https://gone.test/trips.csv" } : null });
  await rm(csv);
  const result = await inspectGeometry(testAccountScope(), table.name);
  expect(result).toMatchObject({ tableId: table.id, geometryRecord: null, currentChoice: null, mode: "unmodified", geometryColumn: null });
  expect(result.columns[1].name).toBe("column01");
  expect(result.candidates[0]).toMatchObject({ columns: ["column01"], format: "wkt", strength: "strong", applied: false, sourceRetained: true });
  for (const columns of [["column04", "column05"], ["column06", "column07"]]) {
    expect(result.candidates).toContainEqual(expect.objectContaining({ columns, format: "pair", strength: "weak", applied: false }));
  }
  expect(getTableByName(table.name)).toEqual(table);
  expect(fetchSource).not.toHaveBeenCalled();
});
it("stored detection keeps name precedence, weak order, ambiguity and the 1000-row bound", async () => {
  const table = await stored(`SELECT CASE WHEN i=1000 THEN 'bad' ELSE 'POINT (10 20)' END payload,
    'POINT (30 40)' wkt, 1::DOUBLE x, 2::DOUBLE y FROM range(1001) t(i)`);
  const result = await inspectGeometry(testAccountScope(), table.name);
  expect(result.candidates.slice(0, 2).map(c => c.columns)).toEqual([["wkt"], ["payload"]]);
  expect(result.candidates.find(c => c.columns[0] === "payload")).toMatchObject({ strength: "strong", sample: { rows: 1000, nonNull: 1000, readable: 1000 } });
  expect(result.candidates.find(c => c.format === "pair")).toMatchObject({ strength: "weak", columns: ["x", "y"] });
  expect(result.candidates.every(c => !c.applied && c.sourceRetained)).toBe(true);
});
it("current flags describe actual retained input and consumed names stay unavailable", async () => {
  const src = path.join(dir, "content.csv");
  await writeFile(src, 'payload,label\n"POINT (10 20)",a\n');
  const retained = await ingestFile(testAccountScope(), src, "content.csv");
  expect(await inspectGeometry(testAccountScope(), retained.name)).toMatchObject({ currentChoice: { format: "wkt", columns: ["payload"] }, candidates: [expect.objectContaining({ applied: true })] });
  await writeFile(src, 'wkt,label\n"POINT (10 20)",a\n');
  const consumed = await ingestFile(testAccountScope(), src, "named.csv");
  const result = await inspectGeometry(testAccountScope(), consumed.name);
  expect(result.currentChoice).toBeNull();
  expect(result.candidates).toEqual([]);
  expect(result.columns.some(c => c.name === "wkt")).toBe(false);
  await withConnection(async conn => { expect((await conn.runAndReadAll("SELECT 1 n")).getRowObjects()[0].n).toBe(1); });
});
it.each([
  ["wkt","POINT (10 20)","assumed"],
  ["wkt","SRID=3857;POINT (1113194.9079327357 0)","declared"],
  ["geojson",'{"type":"Point","coordinates":[10,20]}',"inherent"],
  ["wkb","010100000000000000000024400000000000003440","assumed"],
  ["h3","8928308280fffff","inherent"],
])("stored %s recognition keeps format, strength and source CRS (%s)",async(format,value,stance)=>{
  const t=await stored(`SELECT * FROM (VALUES (${lit(value)}), (NULL)) t(payload)`);
  expect((await inspectGeometry(testAccountScope(), t.name)).candidates).toEqual([expect.objectContaining({columns:["payload"],format,strength:"strong",sample:{rows:2,nonNull:1,readable:1},crs:expect.objectContaining({stance}),applied:false})]);
});
it("weak alternatives keep ordering and numeric ambiguity; below-sample and unlisted sources stay unapplied",async()=>{
  const t=await stored("SELECT * FROM (VALUES ('POINT (1 2)','POINT (3 4)',10,20,30,40),('bad','POINT (5 6)',11,21,31,41),('bad','bad',12,22,32,42)) t(sparse,dense,x,y,m,n)");
  expect((await inspectGeometry(testAccountScope(), t.name)).candidates.map(c=>c.columns)).toEqual([["dense"],["sparse"],["x","y"],["y","m"],["m","n"],["x","m"],["x","n"],["y","n"]]);
  const below=await stored("SELECT CASE WHEN i=1000 THEN 'POINT (10 20)' END payload FROM range(1001) t(i)");
  expect((await inspectGeometry(testAccountScope(), below.name)).candidates).toEqual([]);
  const projected=await stored("SELECT 391779.25925275 a, 5820072.159211026 b");
  expect((await inspectGeometry(testAccountScope(), projected.name)).candidates).toEqual([]);
});

it("field round: repeated and concurrent inspection reuses recognition until the artifact changes", async () => {
  const recognition = await import("@/lib/ingest/content-recognition");
  const spy = vi.spyOn(recognition, "recognizeStoredContent");
  try {
    const t = await stored("SELECT 'POINT (10 20)' payload, 10 x, 20 y");
    const [first, second] = await Promise.all([inspectGeometry(testAccountScope(), t.name), inspectGeometry(testAccountScope(), t.name)]);
    expect(second).toEqual(first);
    expect(await inspectGeometry(testAccountScope(), t.name)).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    const { setGeometry } = await import("./service");
    await setGeometry(testAccountScope(), t.name, first.revision, { format: "wkt", columns: ["payload"] });
    const changed = await inspectGeometry(testAccountScope(), t.name);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.candidates.find(c => c.format === "wkt")?.applied).toBe(true);
  } finally { spy.mockRestore(); }
});
it("field round: candidate identity includes every pair and all evidence", async () => {
  const t = await stored(`SELECT CASE WHEN i=1001 THEN 'LINESTRING (10 20, 181 21)' ELSE 'POINT (10 20)' END payload,
    i % 20 a, i % 30 b, i % 40 c, i % 50 d, i % 60 e, i % 70 f, i % 80 g, i % 90 h, i % 85 j, i % 60 k
    FROM range(1002) t(i)`);
  const result = await inspectGeometry(testAccountScope(), t.name);
  expect(result.candidates.filter(c => c.format === "pair")).toHaveLength(45);
  expect(result.candidates).toMatchSnapshot();
});

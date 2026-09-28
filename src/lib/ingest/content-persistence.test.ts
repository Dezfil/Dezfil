import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb, metadataDb, MIGRATIONS } from "@/lib/metadata/db";
import { getTableByName, type DataTable } from "@/lib/metadata/tables";
import { inspectTable } from "@/lib/table-service";
import { resetQueryInstance } from "@/lib/duckdb";
import { POST } from "@/app/api/tables/route";
import { ingestFile } from "./ingest";
import { importFromUrl } from "./remote";
import { refreshTable } from "./refresh";
import { resetRefreshFences } from "./fence";
import { retirementsSettled } from "./retire";

// Exercise the real URL import/conversion/swap with deterministic downloaded
// sources, without requiring a listening socket in the sandbox.
let remoteCsv = "";
let dir: string;
vi.mock("@/lib/net/remote-fetch", () => ({
  openRemote: vi.fn(async () => {
    const { Readable } = await import("node:stream");
    return { statusCode: 200, headers: { "content-type": "text/csv" }, body: Readable.from([remoteCsv]) };
  }),
}));

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-store-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb(); resetQueryInstance(); resetRefreshFences();
});
afterEach(async () => {
  await retirementsSettled();
  closeMetadataDb(); resetQueryInstance();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});
async function local(csv: string, name = "local.csv") {
  const file = path.join(dir, name); await writeFile(file, csv);
  return ingestFile(file, name);
}
type WithRecord = DataTable & { geometryRecord?: { columns: string[]; unreadableCount: number }; geometryCandidates?: unknown[] };

it("actual upload response, close/reopen and table inspection preserve the selected column and full count", async () => {
  const csv = 'label,payload\n' + Array.from({ length: 1000 }, () => 'a,"POINT (10 20)"\n').join("") + 'b,bad\n';
  const form = new FormData();
  form.set("file", new Blob([csv], { type: "text/csv" }), "upload.csv");
  const response = await POST(new Request("http://dezfil.test/api/tables", { method: "POST", body: form }));
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body).toMatchObject({ geometryRecord: { columns: ["payload"], unreadableCount: 1 }, geometryCandidates: [{ applied: true, sample: { rows: 1000, nonNull: 1000, readable: 1000 } }] });
  const record = body.geometryRecord;
  closeMetadataDb();
  expect(getTableByName(body.name)).toMatchObject({ geometryRecord: record, geometryCandidates: body.geometryCandidates });
  const inspected = await inspectTable(body.name);
  expect(inspected).toMatchObject({ geometryRecord: record, rowCount: 1001 });
});

it("legacy records remain absent after the next migration", async () => {
  // Construct the historical store rather than winding back a current
  // schema, which would replay unrelated additive migrations twice.
  await mkdir(process.env.DEZFIL_DATA_DIR!, { recursive: true });
  const db = new Database(path.join(process.env.DEZFIL_DATA_DIR!, "metadata.sqlite"));
  for (const migration of MIGRATIONS.slice(0, 38)) db.exec(migration);
  db.prepare(`INSERT INTO data_tables (id, name, format, file, row_count, created_at)
    VALUES ('legacy', 'legacy', 'csv', 'tables/legacy.parquet', 1, ?)`)
    .run(new Date().toISOString());
  db.pragma("user_version = 38");
  db.close();
  const reopened = getTableByName("legacy") as WithRecord;
  expect(reopened.geometryRecord).toBeUndefined();
  expect(reopened.geometryCandidates).toBeUndefined();
  const newColumns = metadataDb().prepare("PRAGMA table_info(data_tables)").all() as { name: string }[];
  expect(newColumns.some(c => c.name === "geometry_recognition")).toBe(true);
});

it("local and URL imports agree; a successful refresh replaces record and candidates with its artifact", async () => {
  remoteCsv = 'payload,label\n"SRID=4326;POINT (10 20)",a\n';
  const file = await local(remoteCsv) as WithRecord;
  const url = (await importFromUrl("https://fixture.test/remote.csv")).tables[0] as WithRecord;
  expect(file.geometryRecord).toMatchObject({ columns: ["payload"], unreadableCount: 0 });
  expect(url.geometryRecord).toEqual(file.geometryRecord);
  expect(url.geometryCandidates).toEqual(file.geometryCandidates);
  remoteCsv = 'other,label\n"LINESTRING (30 40, 31 41)",a\n';
  const refreshed = await refreshTable(url.name) as WithRecord;
  expect(refreshed.file).not.toBe(url.file);
  expect(refreshed.geometryRecord).toMatchObject({ columns: ["other"], unreadableCount: 0 });
  expect(getTableByName(url.name)).toMatchObject({ geometryRecord: refreshed.geometryRecord, geometryCandidates: refreshed.geometryCandidates });
  remoteCsv = "name,value\na,1\n";
  expect(await refreshTable(url.name)).toMatchObject({ geometryColumn: null, geometryRecord: null, geometryCandidates: [] });
});

it("a failure after conversion keeps the old artifact and record together", async () => {
  remoteCsv = 'payload,label\n"POINT (10 20)",a\n';
  const before = (await importFromUrl("https://fixture.test/remote.csv")).tables[0] as WithRecord;
  expect(before.geometryRecord).toMatchObject({ columns: ["payload"] });
  const tablesDir = path.join(process.env.DEZFIL_DATA_DIR!, "tables");
  const filesBefore = await readdir(tablesDir);
  metadataDb().exec("CREATE TRIGGER fail_refresh BEFORE UPDATE ON data_tables BEGIN SELECT RAISE(ABORT, 'seeded publication failure'); END");
  remoteCsv = 'new_shape,label\n"POINT (30 40)",b\n';
  await expect(refreshTable(before.name)).rejects.toThrow("seeded publication failure");
  expect(getTableByName(before.name)).toEqual(before);
  expect(await readdir(tablesDir)).toEqual(filesBefore);
});

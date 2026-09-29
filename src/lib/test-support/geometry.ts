import { testAccountScope } from "@/lib/test-support/accounts";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { closeMetadataDb } from "@/lib/metadata/db";
import { insertTable, type DataTable } from "@/lib/metadata/tables";
import { resetQueryInstance, withConnection } from "@/lib/duckdb";
import { lit } from "@/lib/ingest/sql";
import { resetRefreshFences } from "@/lib/ingest/fence";
import { retirementsSettled } from "@/lib/ingest/retire";

export async function setupGeometryTest() {
  await mkdir(path.join(process.cwd(), ".claude"), { recursive: true });
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-"));
  process.env.DEZFIL_DATA_DIR = path.join(dir, "data");
  closeMetadataDb(); resetQueryInstance(); resetRefreshFences();
  await mkdir(path.join(process.env.DEZFIL_DATA_DIR, "tables"), { recursive: true });
  return dir;
}
export async function cleanupGeometryTest(dir: string) {
  await retirementsSettled();
  closeMetadataDb(); resetQueryInstance(); resetRefreshFences();
  delete process.env.DEZFIL_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
}
/** Direct legacy registration: no converter or upload ever saw the source. */
export async function stored(select: string, overrides: Partial<DataTable> = {}) {
  const id = randomUUID();
  const file = `tables/${id}.parquet`;
  const count = await withConnection(async conn => {
    await conn.run(`COPY (${select}) TO ${lit(path.join(process.env.DEZFIL_DATA_DIR!, file))} (FORMAT PARQUET)`);
    return Number((await conn.runAndReadAll(`SELECT count(*) n FROM read_parquet(${lit(path.join(process.env.DEZFIL_DATA_DIR!, file))})`)).getRowObjects()[0].n);
  });
  const table: DataTable = {
    id, name: `fixture_${id.replaceAll("-", "")}`, file, sourceFilename: "gone.csv", format: "csv",
    geometryColumn: null, geometryType: null, crsAssumed: false, headerSuspect: false,
    source: "upload", sourceParams: null, rowCount: count,
    createdAt: "2026-09-01T00:00:00.000Z", importedAt: "2026-09-01T00:00:00.000Z", ...overrides,
  };
  insertTable(testAccountScope(), table);
  return table;
}

import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ingestScratchDir } from "@/lib/ingest/scratch";
import { ident, lit } from "@/lib/ingest/sql";

/** Preview fits in memory; full input uses the writable, boot-swept ingest
 * scratch directory. Small row groups bound the writer's buffered input. */
export async function stageGeometry(conn: DuckDBConnection, select: string, full: boolean, accountId?: string) {
  const name = `geometry_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!full) {
    const from = ident(name);
    await conn.run(`CREATE TEMP TABLE ${from} AS ${select}`);
    return { from, dispose: async () => { await conn.run(`DROP TABLE ${from}`); } };
  }
  const dir = ingestScratchDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.parquet`);
  if (accountId) registerAccountFile(accountId, file);
  const dispose = async () => { await removeAccountFile(file, { force: true }); };
  try {
    // Parquet can report an entirely null geometry column as BLOB. Retain
    // the evaluated schema, including geometry CRS types, across this hop.
    const schema = (await conn.runAndReadAll(`DESCRIBE ${select}`)).getRowObjects();
    const geometry = schema.filter(c => String(c.column_type).startsWith("GEOMETRY"))
      .map(c => `CAST(${ident(String(c.column_name))} AS ${String(c.column_type)}) AS ${ident(String(c.column_name))}`);
    await conn.run(`COPY (${select}) TO ${lit(file)} (FORMAT PARQUET, ROW_GROUP_SIZE 2048)`);
    const from = `read_parquet(${lit(file)})`;
    return { from: geometry.length ? `(SELECT * REPLACE (${geometry.join(", ")}) FROM ${from})` : from, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

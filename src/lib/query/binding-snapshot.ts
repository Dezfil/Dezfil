import type { DuckDBConnection } from "@duckdb/node-api";
import type { DataTable } from "@/lib/metadata/tables";

/** Only the facts materialization needs from the generation it actually bound. */
export type BoundTable = Readonly<Pick<DataTable,
  "id" | "name" | "file" | "geometryColumn" | "crsAssumed"
>>;

export interface BindingSnapshot {
  byName: ReadonlyMap<string, BoundTable>;
  geometryOf(name: string): string | null;
}

/**
 * Called inside the serialized registration turn, after its catalog writes
 * committed and before another pass can replace a view.
 *
 * BEGIN alone does not pin DuckDB's catalog: its snapshot is lazy. A catalog
 * read establishes it here, so discovery, DESCRIBE, COPY and measurement all
 * see the same views even after another connection registers new artifacts.
 * The caller commits this read transaction BEFORE its metadata publication;
 * on failure the bounded boundary disconnects and rolls it back. The entire
 * lifetime remains an in-flight artifact reader, including this handoff.
 *
 * Evidence comes from this registration pass's successes, including its
 * usable-but-unprobed views, never a later registry or shared-map read. A
 * reset's orphan catalog therefore carries its own evidence as well.
 */
export async function pinBindings(
  conn: DuckDBConnection,
  registered: readonly DataTable[],
): Promise<BindingSnapshot> {
  await conn.run("BEGIN TRANSACTION");
  await conn.runAndReadAll("SELECT count(*) FROM duckdb_views()");
  const byName = new Map(registered.map((table) => [
    table.name.toLowerCase(),
    Object.freeze({
      id: table.id,
      name: table.name,
      file: table.file,
      geometryColumn: table.geometryColumn,
      crsAssumed: table.crsAssumed,
    }),
  ]));
  return { byName, geometryOf: (name) => byName.get(name.toLowerCase())?.geometryColumn ?? null };
}

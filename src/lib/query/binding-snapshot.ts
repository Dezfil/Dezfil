import type { DuckDBConnection } from "@duckdb/node-api";
import type { DataTable } from "@/lib/metadata/tables";
import type { RegisteredMount } from "./views";

/** Only the facts materialization needs from the generation it actually bound. */
export type BoundTable = Readonly<Pick<DataTable,
  "id" | "name" | "file" | "geometryColumn" | "crsAssumed"
>>;

export interface BindingSnapshot {
  /** The evidence by dataset identity: what materialization records. */
  byId: ReadonlyMap<string, BoundTable>;
  /** The same evidence by the view each was mounted under: a plain name,
   * or `<sql name>.<dataset>` for another owner's dataset. */
  byName: ReadonlyMap<string, BoundTable>;
  geometryOf(name: string): string | null;
}

/**
 * Called after this evaluation mounted its own local views.
 *
 * BEGIN alone does not pin DuckDB's catalog: its snapshot is lazy. A catalog
 * read establishes it here, so discovery, DESCRIBE, COPY and measurement all
 * see the same views and the evidence captured for this connection.
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
  registered: readonly (DataTable | RegisteredMount)[],
): Promise<BindingSnapshot> {
  await conn.run("BEGIN TRANSACTION");
  await conn.runAndReadAll("SELECT count(*) FROM duckdb_views()");
  const bound = registered.map((table) => Object.freeze({
    id: table.id,
    name: table.name,
    file: table.file,
    geometryColumn: table.geometryColumn,
    crsAssumed: table.crsAssumed,
  }));
  const byId = new Map(bound.map((table) => [table.id, table]));
  const byName = new Map(registered.flatMap((table, index) => {
    const view = "view" in table ? table.view : table.name;
    return view === null ? [] : [[view.toLowerCase(), bound[index]] as const];
  }));
  return { byId, byName, geometryOf: (name) => byName.get(name.toLowerCase())?.geometryColumn ?? null };
}

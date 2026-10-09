import type { Database } from "better-sqlite3";
import path from "node:path";
import type { StorageReferences } from "./storage-places";

/**
 * Which files the metadata references, read first and short, in one
 * transaction: the file names of the registered tables, which the table
 * sweep keeps, and the layers with a tile record, whose archives the
 * archive sweep keeps. Nothing else is read, and none of it leaves the
 * storage read.
 *
 * The database read is synchronous, so it is taken in bounded slices with
 * the deadline checked between them: past it the read stops, and without
 * every reference no file can be told.
 */

/** Rows read in one slice. */
const SLICE_ROWS = 200;

/** Every value of one column, slice by slice in key order, or null once the
 * deadline has passed between two slices. */
function readSliced(db: Database, table: "data_tables" | "layer_tiles", key: string, column: string, deadline: number): string[] | null {
  const first = db.prepare(`SELECT ${key} AS at, ${column} AS value FROM ${table} ORDER BY ${key} LIMIT ?`);
  const next = db.prepare(`SELECT ${key} AS at, ${column} AS value FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`);
  const values: string[] = [];
  let after: string | null = null;
  for (;;) {
    if (Date.now() >= deadline) return null;
    const rows = (after === null ? first.all(SLICE_ROWS) : next.all(after, SLICE_ROWS)) as { at: string; value: string }[];
    for (const row of rows) values.push(row.value);
    if (rows.length < SLICE_ROWS) return values;
    after = rows[rows.length - 1].at;
  }
}

/** The references, or null when the deadline passed before they were all read. */
export function readStorageReferences(db: Database, deadline: number): StorageReferences | null {
  return db.transaction(() => {
    const tableFiles = readSliced(db, "data_tables", "id", "file", deadline);
    const tileLayers = tableFiles && readSliced(db, "layer_tiles", "layer_id", "layer_id", deadline);
    if (!tableFiles || !tileLayers || Date.now() >= deadline) return null;
    return { tableFiles: new Set(tableFiles.map(file => path.basename(file))), tileLayers: new Set(tileLayers) };
  })();
}

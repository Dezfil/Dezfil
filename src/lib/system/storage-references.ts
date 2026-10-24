import type { Database } from "better-sqlite3";
import path from "node:path";
import { ownershipRecordName } from "@/lib/ingest/file-ownership";
import { PICTURE_FOLDER, pictureName } from "@/lib/profile-pictures/store";
import type { StorageReferences } from "./storage-places";

/**
 * Which files the metadata references, read first and short, in one
 * transaction: the file names of the registered tables, which the table
 * sweep keeps, the layers with a tile record, whose archives the archive
 * sweep keeps, and the accounts' current picture versions, whose files and
 * records the picture sweep keeps. Nothing else is read, and none of it
 * leaves the storage read. What the installed templates reference is read beside it,
 * from their records (storage.ts).
 *
 * The database read is synchronous, so it is taken in bounded slices with
 * the deadline checked between them: past it the read stops, and without
 * every reference no file can be told.
 */

/** Rows read in one slice. */
const SLICE_ROWS = 200;

interface Row<V> { readonly at: string; readonly value: V }

/** Every row's key and one column, slice by slice in key order, or null
 * once the deadline has passed between two slices. */
function readSliced<V = string>(db: Database, table: "data_tables" | "layer_tiles" | "accounts", key: string, column: string,
  deadline: number): Row<V>[] | null {
  const first = db.prepare(`SELECT ${key} AS at, ${column} AS value FROM ${table} ORDER BY ${key} LIMIT ?`);
  const next = db.prepare(`SELECT ${key} AS at, ${column} AS value FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`);
  const values: Row<V>[] = [];
  let after: string | null = null;
  for (;;) {
    if (Date.now() >= deadline) return null;
    const rows = (after === null ? first.all(SLICE_ROWS) : next.all(after, SLICE_ROWS)) as Row<V>[];
    values.push(...rows);
    if (rows.length < SLICE_ROWS) return values;
    after = rows[rows.length - 1].at;
  }
}

/** The metadata's references, or null when the deadline passed before
 * they were all read. */
export function readStorageReferences(db: Database, deadline: number): Omit<StorageReferences, "templateFiles"> | null {
  return db.transaction(() => {
    const tableFiles = readSliced(db, "data_tables", "id", "file", deadline);
    const tileLayers = tableFiles && readSliced(db, "layer_tiles", "layer_id", "layer_id", deadline);
    const pictures = tileLayers && readSliced<string | null>(db, "accounts", "id", "picture_version", deadline);
    if (!tableFiles || !tileLayers || !pictures || Date.now() >= deadline) return null;
    const pictureFiles = pictures.flatMap(row => row.value === null ? [] : [pictureName(row.at, row.value)]);
    return {
      tableFiles: new Set(tableFiles.map(row => path.basename(row.value))),
      tileLayers: new Set(tileLayers.map(row => row.value)),
      pictureFiles: new Set(pictureFiles),
      pictureRecords: new Set(pictureFiles.map(name => ownershipRecordName(path.join(PICTURE_FOLDER, name)))),
    };
  })();
}

import type { Database } from "better-sqlite3";
import path from "node:path";
import { tileRecordLayerIds } from "@/lib/metadata/tiles";
import type { StorageReferences } from "./storage-places";

/**
 * Which files the metadata references, read first and short, in one
 * transaction: the file names of the registered tables, which the table
 * sweep keeps, and the layers with a tile record, whose archives the
 * archive sweep keeps. Nothing else is read, and none of it leaves the
 * storage read.
 */
export function readStorageReferences(db: Database): StorageReferences {
  return db.transaction(() => ({
    tableFiles: new Set((db.prepare(`SELECT file FROM data_tables`).pluck().all() as string[]).map(file => path.basename(file))),
    tileLayers: new Set(tileRecordLayerIds(db)),
  }))();
}

import type { Database } from "better-sqlite3";
import { metadataDb } from "./db";

/**
 * Build records for tiled layers. One row per layer: which effective query
 * (fingerprint) its archive was built from, and where the build stands. The
 * archive itself lives on disk (see tiles/paths); the row is what makes
 * freshness decidable across restarts.
 */

export type TileState = "building" | "ready" | "failed";

export interface TileRecord {
  layerId: string;
  state: TileState;
  fingerprint: string;
  error: string | null;
  featureCount: number | null;
  builtAt: string | null;
  updatedAt: string;
}

interface TileRow {
  layer_id: string;
  state: TileState;
  fingerprint: string;
  error: string | null;
  feature_count: number | null;
  built_at: string | null;
  updated_at: string;
}

function fromRow(r: TileRow): TileRecord {
  return {
    layerId: r.layer_id,
    state: r.state,
    fingerprint: r.fingerprint,
    error: r.error,
    featureCount: r.feature_count,
    builtAt: r.built_at,
    updatedAt: r.updated_at,
  };
}

export function getTileRecord(
  layerId: string,
  db: Database = metadataDb(),
): TileRecord | null {
  const row = db
    .prepare(`SELECT * FROM layer_tiles WHERE layer_id = ?`)
    .get(layerId) as TileRow | undefined;
  return row ? fromRow(row) : null;
}

export function upsertTileRecord(
  record: Omit<TileRecord, "updatedAt">,
  db: Database = metadataDb(),
): void {
  db.prepare(
    `INSERT INTO layer_tiles
       (layer_id, state, fingerprint, error, feature_count, built_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(layer_id) DO UPDATE SET
       state = excluded.state,
       fingerprint = excluded.fingerprint,
       error = excluded.error,
       feature_count = excluded.feature_count,
       built_at = excluded.built_at,
       updated_at = excluded.updated_at`,
  ).run(
    record.layerId,
    record.state,
    record.fingerprint,
    record.error,
    record.featureCount,
    record.builtAt,
    new Date().toISOString(),
  );
}

export function deleteTileRecord(
  layerId: string,
  db: Database = metadataDb(),
): void {
  db.prepare(`DELETE FROM layer_tiles WHERE layer_id = ?`).run(layerId);
}

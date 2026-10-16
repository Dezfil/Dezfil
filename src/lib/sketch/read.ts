import { withTrustedOperation } from "@/lib/trusted-operation";
import { metadataDb } from "../metadata/db";
import { documentFacts, type DocumentFacts } from "../metadata/document-facts";
import { requireReachable } from "@/lib/auth/reach";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import type { AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { lit } from "@/lib/ingest/ingest";
import { type DataTable } from "@/lib/metadata/tables";
import { addressDataset, requireOwnDataset } from "@/lib/dataset-address";
import { getOwnedTableByName } from "@/lib/metadata/owned-tables";
import { trackInflight } from "@/lib/query/inflight";
import type { SketchFeature, SketchGeometry, SketchKind } from "./geometry";
import { sketchFeatureAnswer } from "./feature-answer";
import { limits } from "@/lib/limits";

export interface StoredSketchFeature extends SketchFeature {
  id: string;
}

export interface SketchSummary extends DocumentFacts {
  table: string;
  tableId: string;
  mapId: string;
  layerId: string | null;
  rowCount: number;
  counts: Partial<Record<SketchKind, number>>;
}

/** A sketch its drawer changes: the caller's own, by any of its addresses (a
 * bare name is the caller's own); another person's sketch the caller reaches
 * is refused by the permission shape, whatever the map's role grants. */
export function requireSketch(scope: AccountScope, name: string): DataTable {
  return sketchOnly(ownByName(scope, name) ?? requireOwnDataset(scope, name).table, name);
}

/** A sketch read: any sketch dataset the caller reaches. */
function readableSketch(scope: AccountScope, name: string): DataTable {
  return sketchOnly(ownByName(scope, name) ?? addressDataset(scope, name).table, name);
}

/** The caller's own dataset by its bare name, read once, as it always was;
 * any other address resolves as a dataset address does. */
function ownByName(scope: AccountScope, name: string): DataTable | null {
  return getOwnedTableByName(scope, name);
}

function sketchOnly(table: DataTable, name: string): DataTable {
  if (table.source !== "sketch")
    throw new ApiError(
      "not_a_sketch",
      `"${name}" is not a sketch dataset; sketch operations apply only to tables drawn on a map.`,
      404,
    );
  return table;
}

export function ownerOf(table: DataTable): {
  mapId: string | null;
  layerId: string | null;
} {
  const params = table.sourceParams ?? {};
  const mapId = typeof params.mapId === "string" ? params.mapId : null;
  const layerId = typeof params.layerId === "string" ? params.layerId : null;
  return { mapId, layerId };
}

function absOf(rel: string): string {
  return path.join(dataDir(), rel);
}

export async function readFeatures(abs: string, signal?: AbortSignal): Promise<StoredSketchFeature[]> {
  return withTrustedOperation({ kind: "interactive-read", name: "Sketch read", signal }, async () => {
    return withConnection(async (conn) => {
      // An emptied sketch's artifact reads its geometry column back as BLOB
      // (no rows, no GeoParquet metadata), and ST_AsGeoJSON(BLOB) is a
      // binder error — so the zero-row case answers before geometry binds.
      const counted = await conn.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet(${lit(abs)})`,
      );
      if (Number(counted.getRowObjects()[0].n) === 0) return [];
      const rows = await conn.runAndReadAll(
        `SELECT feature_id, kind, CAST(ST_AsGeoJSON(geom) AS VARCHAR) AS gj
         FROM read_parquet(${lit(abs)}) WHERE feature_id IS NOT NULL`,
      );
      return rows.getRowObjects().map((r) => ({
        id: String(r.feature_id),
        kind: String(r.kind) as SketchKind,
        geometry: JSON.parse(String(r.gj)) as SketchGeometry,
      }));
    });
  });
}

/** The features as the features read answers them, bounded by Bytes drawn
 * per layer. Changes read through `readFeatures`, which is not: a sketch
 * too large to read whole can still be changed. */
async function readFeatureAnswer(abs: string): Promise<StoredSketchFeature[]> {
  return withConnection(async (conn) => {
    const counted = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet(${lit(abs)})`,
    );
    return sketchFeatureAnswer(conn, abs, Number(counted.getRowObjects()[0].n), limits.renderCapBytes);
  });
}

export function listFeatures(
  scope: AccountScope,
  name: string,
  signal?: AbortSignal,
): Promise<StoredSketchFeature[]> {
  return withTrustedOperation({ kind: "interactive-read", name: "Sketch read", signal }, async () => {
    // Register before capture; protection spans both count and geometry opens.
    return trackInflight(Promise.resolve().then(() => {
      const table = readableSketch(scope, name);
      return readFeatureAnswer(absOf(table.file));
    }));
  });
}

/** The caller's own sketch datasets drawn on a map they reach: never another
 * person's, whoever the map belongs to. */
export function mapSketches(scope: AccountScope, mapId: string, signal?: AbortSignal): Promise<SketchSummary[]> {
  return withTrustedOperation({ kind: "interactive-read", name: "Sketch read", signal }, async () => {
    requireReachable(scope, "map", mapId);
    // One registry snapshot and one tracked lifetime for the whole traversal.
    return trackInflight(Promise.resolve().then(async () => {
      const { tables, facts } = metadataDb().transaction(() => ({
        facts: documentFacts({ kind: "map", id: mapId }),
        tables: listOwnedTables(scope).filter(t => t.source === "sketch" && ownerOf(t).mapId === mapId),
      }))();
      const summaries: SketchSummary[] = [];
      for (const table of tables) {
        const counts: Partial<Record<SketchKind, number>> = {};
        if (table.rowCount > 0) {
          await withConnection(async (conn) => {
            const rows = await conn.runAndReadAll(
              `SELECT kind, count(*) AS n FROM read_parquet(${lit(absOf(table.file))})
               WHERE kind IS NOT NULL GROUP BY kind`,
            );
            for (const r of rows.getRowObjects())
              counts[String(r.kind) as SketchKind] = Number(r.n);
          });
        }
        summaries.push({
          ...facts,
          table: table.name,
          tableId: table.id,
          mapId,
          layerId: ownerOf(table).layerId,
          rowCount: table.rowCount,
          counts,
        });
      }
      requireReachable(scope, "map", mapId);
      return summaries;
    }));
  });
}


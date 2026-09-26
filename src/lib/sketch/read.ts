import path from "node:path";
import { dataDir } from "@/lib/config";
import { withConnection } from "@/lib/duckdb";
import { ApiError } from "@/lib/api/errors";
import { lit } from "@/lib/ingest/ingest";
import { listTables, type DataTable } from "@/lib/metadata/tables";
import { requireTable } from "@/lib/table-service";
import { trackInflight } from "@/lib/query/inflight";
import type { SketchFeature, SketchGeometry, SketchKind } from "./geometry";

export interface StoredSketchFeature extends SketchFeature {
  id: string;
}

export interface SketchSummary {
  table: string;
  tableId: string;
  mapId: string;
  layerId: string | null;
  rowCount: number;
  counts: Partial<Record<SketchKind, number>>;
}

export function requireSketch(name: string): DataTable {
  const table = requireTable(name);
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

export async function readFeatures(abs: string): Promise<StoredSketchFeature[]> {
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
}

export function listFeatures(
  name: string,
): Promise<StoredSketchFeature[]> {
  // Register before capture; protection spans both count and geometry opens.
  return trackInflight(Promise.resolve().then(() => {
    const table = requireSketch(name);
    return readFeatures(absOf(table.file));
  }));
}

export function mapSketches(mapId: string): Promise<SketchSummary[]> {
  // One registry snapshot and one tracked lifetime for the whole traversal.
  return trackInflight(Promise.resolve().then(async () => {
    const tables = listTables().filter(
      (t) => t.source === "sketch" && ownerOf(t).mapId === mapId,
    );
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
        table: table.name,
        tableId: table.id,
        mapId,
        layerId: ownerOf(table).layerId,
        rowCount: table.rowCount,
        counts,
      });
    }
    return summaries;
  }));
}


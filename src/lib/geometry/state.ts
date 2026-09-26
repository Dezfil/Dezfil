import type { Database } from "better-sqlite3";
import { metadataDb } from "@/lib/metadata/db";
import type { DataTable } from "@/lib/metadata/tables";
import { geometryEvidence, type GeometryEvidence } from "@/lib/geometry-evidence";
import type { GeometryChoice } from "./types";

/** Private replay/ownership information stored atomically in the existing
 * geometry_recognition JSON. It is never spread into a public Table. */
export interface GeometryState {
  mode: "set" | "cleared";
  choice: GeometryChoice | null;
  outputColumn: string | null;
  sourceRetained: boolean;
  /** A consumed CSV's historical name exists again on the fresh URL source. */
  replayChoice?: GeometryChoice;
  /** A native source must be read before the usual reprojection conversion. */
  nativeSource?: boolean;
}
export interface GeometryStorage extends GeometryEvidence { geometryState?: GeometryState | null }
export function serializeGeometryStorage(value: GeometryStorage): string | null {
  const saved = { ...geometryEvidence(value), ...(value.geometryState ? { geometryState: value.geometryState } : {}) };
  return Object.keys(saved).length ? JSON.stringify(saved) : null;
}
export function getGeometryState(table: Pick<DataTable, "id" | "file">, db: Database = metadataDb()): GeometryState | null {
  const r = db.prepare("SELECT geometry_recognition FROM data_tables WHERE id = ? AND file = ?").get(table.id, table.file) as { geometry_recognition: string | null } | undefined;
  return r?.geometry_recognition ? (JSON.parse(r.geometry_recognition) as GeometryStorage).geometryState ?? null : null;
}

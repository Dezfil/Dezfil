import type { DuckDBConnection } from "@duckdb/node-api";
import type { DataTable, TableFormat } from "@/lib/metadata/tables";
import { ApiError } from "@/lib/api/errors";
import { isCanonicalEquivalent } from "@/lib/crs";
import { suspectCsvHeader } from "@/lib/ingest/csv-geometry";
import { ident, lit } from "@/lib/ingest/sql";
import { buildGeometryArtifact } from "./build";
import { geometryColumns } from "./read";
import { parseGeometryChoice } from "./choice";
import type { GeometryState } from "./state";

export interface GeometryReplay { table: DataTable; state: GeometryState }
function conflictingSource(message: string): never {
  throw new ApiError("geometry_choice_invalid", message, 422, { issues: [{ code: "conflicting_crs", message }] });
}
/** Re-read original values before any ordinary converter consumes/reprojects
 * them. The current output is never a refresh input. */
export async function replayGeometryRelation(conn: DuckDBConnection, from: string, artifact: string, replay: GeometryReplay) {
  const { table, state } = replay;
  const choice = parseGeometryChoice(state.replayChoice ?? state.choice);
  let relation = from;
  const columns = await geometryColumns(conn, relation);
  let geometryColumn: string | null = null;
  if (state.nativeSource) {
    const selected = columns.find(c => c.name === choice.columns[0]);
    if (!selected) throw new ApiError("column_unavailable", `Column "${choice.columns[0]}" is no longer available.`, 400);
    geometryColumn = selected.name;
    const declared = selected.type.match(/^GEOMETRY\('(.+)'\)$/)?.[1];
    if (declared) {
      const code = isCanonicalEquivalent(selected.type) ? 4326 : Number(declared.match(/^EPSG:([0-9]+)$/i)?.[1]);
      if (!code || code !== choice.epsg) conflictingSource(`The fresh source declares ${declared}. The saved projection cannot override it.`);
    }
    if (selected.type === "BLOB") {
      relation = `(SELECT * REPLACE (TRY(ST_GeomFromWKB(${ident(selected.name)})) AS ${ident(selected.name)}) FROM ${from})`;
    }
  }
  // A retained-source replay starts from a plain source relation. A native
  // replay starts from its original geometry and is licensed only by the
  // saved native-source flag and the declaration check above.
  const source: DataTable = {
    ...table, geometryColumn, geometryRecord: undefined, geometryCandidates: undefined,
    crsAssumed: !!state.nativeSource,
    headerSuspect: table.format === "csv" && suspectCsvHeader(columns),
  };
  const built = await buildGeometryArtifact(conn, relation, artifact, source, null, choice, state.outputColumn ?? undefined);
  return built;
}
export function replayFileGeometry(conn: DuckDBConnection, format: TableFormat, sourcePath: string, artifact: string, replay: GeometryReplay) {
  const from = format === "csv" ? `read_csv(${lit(sourcePath)})` : format === "geoparquet" ? `read_parquet(${lit(sourcePath)})` : `ST_Read(${lit(sourcePath)})`;
  return replayGeometryRelation(conn, from, artifact, replay);
}

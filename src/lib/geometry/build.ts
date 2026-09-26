import type { DuckDBConnection } from "@duckdb/node-api";
import type { DataTable } from "@/lib/metadata/tables";
import { ApiError } from "@/lib/api/errors";
import { geometryColumnName } from "@/lib/ingest/csv-geometry";
import { measureArtifact } from "@/lib/ingest/ingest";
import { ident, lit } from "@/lib/ingest/sql";
import { geometryColumns } from "./read";
import { validateGeometryColumns } from "./choice";
import { nativeGeometryChoice } from "./ownership";
import { evaluateGeometry } from "./evaluate";
import { measureGeometry } from "./preview";
import type { GeometryChoice } from "./types";
import type { GeometryState, GeometryStorage } from "./state";

export async function buildGeometryArtifact(conn: DuckDBConnection, from: string, artifact: string,
  table: DataTable, state: GeometryState | null, choice: GeometryChoice, preferredOutput?: string) {
  const columns = await geometryColumns(conn, from);
  const native = nativeGeometryChoice(table, state, columns, choice);
  validateGeometryColumns(choice, columns, native);
  const evaluated = await evaluateGeometry(conn, from, choice, native);
  try {
    if (evaluated.issues.length) throw new ApiError("geometry_choice_invalid", evaluated.issues[0].message, 422, { issues: evaluated.issues });
    const measured = await measureGeometry(conn, evaluated);
    const outputColumn = table.geometryColumn ?? (preferredOutput && !columns.some(c => c.name === preferredOutput) ? preferredOutput : geometryColumnName(columns.map(c => c.name)));
    const originals = columns.filter(c => c.name !== table.geometryColumn).map(c => ident(c.name));
    const select = `SELECT ${[...originals, `${ident(evaluated.output)} AS ${ident(outputColumn)}`].join(", ")} FROM ${evaluated.from}`;
    await conn.run(`COPY (${select}) TO ${lit(artifact)} (FORMAT PARQUET, ROW_GROUP_SIZE 2048)`);
    // The measured relation is exactly what COPY writes. Reuse its full facts
    // instead of reading and decoding the finished parquet again. Keep the
    // existing first-geometry-column rule for artifacts with another geometry.
    const otherGeometry = columns.some(c => c.name !== table.geometryColumn && c.type.startsWith("GEOMETRY"));
    const artifactMeta = otherGeometry ? await measureArtifact(conn, artifact, outputColumn)
      : { geometryColumn: outputColumn, geometryType: measured.geometryType, rowCount: measured.rowCount };
    const historical = native && table.geometryRecord ? { ...choice, columns: table.geometryRecord.columns } : undefined;
    const geometryState: GeometryState = {
      mode: "set", choice, outputColumn, sourceRetained: !native,
      ...(historical ? { replayChoice: historical } : native ? { nativeSource: true } : {}),
    };
    const evidence: GeometryStorage = {
      geometryRecord: { columns: historical?.columns ?? choice.columns, format: choice.format, signal: "manual", rule: "manual", crs: evaluated.crs, unreadableCount: measured.unreadableCount },
      geometryCandidates: [], geometryState,
    };
    return { ...artifactMeta, crsAssumed: evaluated.crs.stance === "assumed", headerSuspect: table.headerSuspect, ...evidence, extent: measured.extent };
  } finally { await evaluated.dispose(); }
}

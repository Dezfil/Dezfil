import type { AccountScope } from "@/lib/auth/scope";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { measureArtifact } from "@/lib/ingest/ingest";
import { ident, lit } from "@/lib/ingest/sql";
import { geometryColumns, readGeometry } from "./read";
import { geometryOwnership, sourceUnavailable } from "./ownership";
import { geometryMutationResult, publishGeometry, withGeometryMutation } from "./mutate";

export function clearGeometry(scope: AccountScope, name: string, expectedRevision: string) {
  return withGeometryMutation(scope, name, expectedRevision, async (table, state) => {
    if (!table.geometryColumn) return geometryMutationResult(scope, table, state, null);
    const file = path.join("tables", `${randomUUID()}.parquet`), artifact = path.join(dataDir(), file);
    try {
      const meta = await readGeometry(table, async (conn, from) => {
        const columns = await geometryColumns(conn, from);
        if (!geometryOwnership(table, state, columns).managed || columns.some(c => c.name !== table.geometryColumn && c.type.startsWith("GEOMETRY"))) {
          sourceUnavailable("Clear would remove native or consumed geometry whose original source is no longer stored. Clearing it is unavailable.");
        }
        await conn.run(`COPY (SELECT * EXCLUDE (${ident(table.geometryColumn!)}) FROM ${from}) TO ${lit(artifact)} (FORMAT PARQUET)`);
        return measureArtifact(conn, artifact);
      });
      return publishGeometry(scope, table, {
        ...meta, file, importedAt: table.importedAt, headerSuspect: table.headerSuspect,
        geometryRecord: null, geometryCandidates: [],
        geometryState: { mode: "cleared", choice: null, outputColumn: null, sourceRetained: true },
      }, null);
    } catch (error) { await rm(artifact, { force: true }); throw error; }
  });
}

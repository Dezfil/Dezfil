import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dataDir } from "@/lib/config";
import { ApiError } from "@/lib/api/errors";
import { getTableByName, updateTableData, type DataTable, type TableDataUpdate } from "@/lib/metadata/tables";
import { metadataDb } from "@/lib/metadata/db";
import { tableProjectIds } from "@/lib/metadata/projects";
import { geometryEvidence } from "@/lib/geometry-evidence";
import { beginRefresh, endRefresh, refreshUnit } from "@/lib/ingest/fence";
import { postCommitCleanup } from "@/lib/ingest/refresh";
import { getGeometryState, type GeometryState } from "./state";
import { geometryRevision, readGeometry, requireGeometryTable } from "./read";
import { parseGeometryChoice } from "./choice";
import { buildGeometryArtifact } from "./build";
import type { GeometryExtent } from "./types";

export function assertGeometryGeneration(table: DataTable) {
  const live = getTableByName(table.name);
  if (!live || live.id !== table.id) throw new ApiError("not_found", "The dataset was deleted while geometry was being prepared.", 404);
  if (live.file !== table.file) throw new ApiError("input_changed", "The dataset changed while geometry was being prepared. Inspect it again.", 409);
}
export function geometryMutationResult(table: DataTable, state: GeometryState | null, extent: GeometryExtent) {
  return { table: { ...table, projectIds: tableProjectIds().get(table.id) ?? [] }, revision: geometryRevision(table),
    currentChoice: state?.sourceRetained ? state.choice : null, mode: state?.mode ?? "unmodified", extent };
}
export function publishGeometry(table: DataTable, update: TableDataUpdate, extent: GeometryExtent) {
  const result = metadataDb().transaction(() => {
    assertGeometryGeneration(table);
    if (!updateTableData(table, update)) throw new ApiError("input_changed", "The dataset changed. Inspect it again.", 409);
    const { geometryState, ...publicUpdate } = update;
    // Public readback is the committed result; internal ownership stays private.
    return geometryMutationResult({ ...table, ...publicUpdate, ...geometryEvidence(update) }, geometryState ?? null, extent);
  })();
  postCommitCleanup(table.name, path.join(dataDir(), table.file));
  return result;
}
export async function withGeometryMutation<T>(name: string, expectedRevision: string, work: (table: DataTable, state: GeometryState | null) => Promise<T>): Promise<T> {
  const table = requireGeometryTable(name, expectedRevision);
  const state = getGeometryState(table);
  const unit = refreshUnit(table);
  try { beginRefresh(unit, name); }
  catch (error) {
    if (error instanceof ApiError && error.code === "refresh_in_flight") throw new ApiError("geometry_in_flight", "A geometry edit or refresh is already running for this dataset or import group.", 409);
    throw error;
  }
  try { return await work(table, state); }
  finally { endRefresh(unit); }
}
export function setGeometry(name: string, expectedRevision: string, input: unknown) {
  return withGeometryMutation(name, expectedRevision, async (table, state) => {
    const choice = parseGeometryChoice(input);
    const file = path.join("tables", `${randomUUID()}.parquet`), artifact = path.join(dataDir(), file);
    try {
      const meta = await readGeometry(table, (conn, from) => buildGeometryArtifact(conn, from, artifact, table, state, choice));
      const { extent, ...facts } = meta;
      return publishGeometry(table, { ...facts, file, importedAt: table.importedAt }, extent);
    } catch (error) { await rm(artifact, { force: true }); throw error; }
  });
}

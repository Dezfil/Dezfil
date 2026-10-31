import { isStorageExhausted, storageExhausted, rethrowStorageFailure } from "@/lib/system/storage-errors";
import { withTrustedMutation } from "@/lib/trusted-mutation";
import { currentTrustedOperation, isTrustedOperationRefusal } from "@/lib/trusted-operation";
import { ownedArchive } from "./owned-archive";
import { copyFileWork, bindDeletionInputs, observeDeletionCleanup } from "@/lib/auth/account-deletion-work";
import { registerAccountFile, removeAccountFile } from "@/lib/ingest/file-ownership";
import { AuthError } from "@/lib/auth/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { canReach, requireReachable } from "@/lib/auth/reach";
import { mkdir, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import { dataDir } from "@/lib/config";
import { listReachableTables } from "@/lib/metadata/owned-tables";
import { projectMemberIds, requireProject } from "@/lib/metadata/owned-projects";
import { readMap } from "@/lib/map-service";
import { datasetPresence } from "@/lib/dataset-presence";
import { readerSqlName } from "@/lib/map-dependencies";
import { recipePayload } from "@/lib/operations/recipe-api";
import { readRecipe } from "@/lib/operations/recipe-view";
import { layoutPayload, readLayout } from "@/lib/operations/recipe-layout";
import { trackInflight } from "@/lib/query/inflight";
import { exportTable } from "@/lib/table-service";
import {
  DEFAULT_DATASET_FORMAT,
  datasetFileName,
  effectiveDatasetFormat,
  type DatasetFormat,
} from "./dataset-format";
import {
  archiveBaseName,
  mapProjection,
  memberFileNames,
  workflowProjection,
} from "./project-archive";

/** The bundle's format version: the manifest's promise to a
 * later importer. Bump on any projection or layout change. */
export const PROJECT_EXPORT_FORMAT_VERSION = 1;

export interface ProjectExportSelection {
  maps: string[];
  recipes: string[];
  tables: string[];
  /** The requested archive base name; normalized by the shared rule. */
  file: string;
  /** One format for every dataset; omitted means
   * the stored GeoParquet, byte for byte. */
  datasetFormat?: DatasetFormat;
}

export interface PreparedProjectExport {
  /** The finalized zip on disk — complete before anyone hears "yes". */
  path: string;
  filename: string;
  size: number;
}

/** One member id set from the request: collapsed to a set (duplicates
 * cannot double an entry), refused when any id is not the project's
 * member, and restored to the kind's canonical listing order. */
function canonical(
  kind: string,
  requested: string[],
  members: string[],
): string[] {
  const wanted = new Set(requested);
  for (const id of wanted) {
    if (!members.includes(id)) {
      throw new ApiError(
        "invalid_request",
        `"${id}" is not one of this project's ${kind}.`,
        400,
      );
    }
  }
  return members.filter((id) => wanted.has(id));
}

/**
 * Every selected member, asked again as the archive completes: still within
 * the initiator's reach and still in the project. One withdrawn while the
 * archive was assembled (unfiled, deleted, or out of reach) fails the whole
 * export by name, as a vanished artifact does: never a thinner archive.
 */
function requireSelectionInReach(
  scope: AccountScope,
  projectId: string,
  chosen: { kind: "map" | "workflow" | "dataset"; id: string; name: string }[],
): void {
  const members = projectMemberIds(scope, projectId);
  const filed = { map: members.maps, workflow: members.recipes, dataset: members.tables };
  for (const member of chosen) {
    if (canReach(scope, member.kind, member.id) && filed[member.kind].includes(member.id)) continue;
    throw new ApiError(
      "export_failed",
      `The ${member.kind} "${member.name}" is not available to you, so the archive was not delivered.`,
      409,
    );
  }
}

/**
 * Assemble the 16-C archive: validate through the read-only member
 * preflight, project every chosen member, and write one zip to a
 * temporary file under the data directory — finalized on disk before
 * any success is claimed, so a failed assembly is a refusal and never a
 * truncated 200. The caller owns the returned file's
 * lifetime (the ticket store deletes it on redeem, expiry or failure).
 */
async function assembleProjectExportWork(
  scope: AccountScope,
  projectId: string,
  selection: ProjectExportSelection,
): Promise<PreparedProjectExport> {
  // Anyone who reaches the project exports it, viewers included; every
  // selected member must be filed in it and within their reach, whoever
  // owns it.
  bindDeletionInputs([requireReachable(scope, "project", projectId).ownerId]);
  const project = requireProject(scope, projectId);
  const members = projectMemberIds(scope, projectId);
  for (const id of selection.maps) bindDeletionInputs([requireReachable(scope, "map", id).ownerId]);
  for (const id of selection.recipes) bindDeletionInputs([requireReachable(scope, "workflow", id).ownerId]);
  for (const id of selection.tables) bindDeletionInputs([requireReachable(scope, "dataset", id).ownerId]);
  const maps = canonical("maps", selection.maps, members.maps);
  const recipes = canonical("workflows", selection.recipes, members.recipes);
  const tables = canonical("datasets", selection.tables, members.tables);
  if (maps.length + recipes.length + tables.length === 0) {
    throw new ApiError(
      "invalid_request",
      "Nothing chosen. Select at least one member to export.",
      400,
    );
  }

  const base = archiveBaseName(selection.file);
  const root = `${base}.dezfil`;
  const requestedFormat = selection.datasetFormat ?? DEFAULT_DATASET_FORMAT;
  // Each dataset goes by the name its exporter types: the plain name for
  // their own, `<sql name>.<name>` for anyone else's, so two people's
  // `roads` are two entries.
  const byId = new Map(listReachableTables(scope).map((t) => [t.table.id, { ...t.table, ...datasetPresence(scope, t) }]));
  const chosenTables = tables
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

  // Maps and workflows carry their SQL home, the account whose datasets
  // their plain names mean.
  const mapDocs = maps.map((id) => {
    const wire = readMap(scope, id) as unknown as Record<string, unknown>;
    return { id, name: String(wire.name ?? id), doc: mapProjection(wire) };
  });
  const workflowDocs = await Promise.all(
    recipes.map(async (id) => {
      const wire = recipePayload(await readRecipe(scope, id));
      return {
        id,
        name: wire.name,
        doc: workflowProjection(wire, layoutPayload(readLayout(scope, id))),
      };
    }),
  );
  const mapFiles = memberFileNames(mapDocs.map((m) => m.name));
  const workflowFiles = memberFileNames(workflowDocs.map((w) => w.name));

  const manifest = {
    formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    generator: "dezfil",
    exportedAt: new Date().toISOString(),
    // Whose names the dataset entries use: theirs plain, anyone else's
    // qualified with the owner's SQL name.
    exportedBy: { sqlName: readerSqlName(scope) },
    project: { name: project.name, note: project.note },
    contents: {
      maps: mapDocs.map((m, i) => ({
        id: m.id,
        name: m.name,
        file: `maps/${mapFiles[i]}.json`,
      })),
      workflows: workflowDocs.map((w, i) => ({
        id: w.id,
        name: w.name,
        file: `workflows/${workflowFiles[i]}.json`,
      })),
      datasets: chosenTables.map((t) => ({
        id: t.id,
        name: t.name,
        qualifiedName: t.qualifiedName,
        owner: t.owner,
        file: `datasets/${datasetFileName(t.qualifiedName, requestedFormat, t.geometryColumn !== null)}`,
        // The effective format per dataset (additive under format
        // version 1): a non-spatial dataset under GeoJSON is CSV.
        format: effectiveDatasetFormat(
          requestedFormat,
          t.geometryColumn !== null,
        ),
      })),
    },
  };

  // Every artifact must exist before assembly begins: a vanished file
  // is a deterministic refusal here, not a mid-stream surprise (the
  // stream catch below still guards the race window).
  for (const t of chosenTables) {
    try {
      await stat(path.join(dataDir(), t.file));
    } catch {
      throw new ApiError(
        "export_failed",
        `The dataset "${t.qualifiedName}" has no stored artifact to export.`,
        500,
      );
    }
  }

  const stagingDir = path.join(dataDir(), "exports");
  await mkdir(stagingDir, { recursive: true });
  // Ticket ownership is process-local, so a crash orphans its staged
  // file: every assembly sweeps siblings old enough that no
  // live ticket can still own them (the TTL is one minute).
  try {
    const now = Date.now();
    for (const name of await readdir(stagingDir)) {
      const p = path.join(stagingDir, name);
      const age = now - (await stat(p)).mtimeMs;
      if (age > 15 * 60_000) await removeAccountFile(p, { force: true });
    }
  } catch {
    // The sweep is best-effort; assembly proceeds regardless.
  }
  const staged = path.join(stagingDir, `${randomUUID()}.zip`);
  registerAccountFile(scope.accountId, staged);

  const operation = currentTrustedOperation()!;
  const archive = ownedArchive(operation);
  operation.defer(() => archive.close());
  operation.defer(async () => { if (operation.signal.aborted) await removeAccountFile(staged, { force: true }); });
  const zip = archive.zip;
  const json = (value: unknown) =>
    Buffer.from(JSON.stringify(value, null, 2) + "\n");
  zip.addBuffer(json(manifest), `${root}/project.json`);
  mapDocs.forEach((m, i) =>
    zip.addBuffer(json(m.doc), `${root}/maps/${mapFiles[i]}.json`),
  );
  workflowDocs.forEach((w, i) =>
    zip.addBuffer(json(w.doc), `${root}/workflows/${workflowFiles[i]}.json`),
  );
  // Conversions are written by the app's own table export road before
  // the zip is built, held until it is finalized, and removed on every
  // exit — success, a conversion that fails, or a zip that fails. The
  // staging sweep never covers them.
  const conversions: { cleanup: () => Promise<void> }[] = [];
  const cleanConversions = async () => {
    const settled = await Promise.allSettled(conversions.splice(0).map(c => observeDeletionCleanup(() => c.cleanup())));
    const failed = settled.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  try {
    for (const t of chosenTables) {
      const spatial = t.geometryColumn !== null;
      const effective = effectiveDatasetFormat(requestedFormat, spatial);
      const entry = `${root}/datasets/${datasetFileName(t.qualifiedName, requestedFormat, spatial)}`;
      if (effective === "geoparquet") {
        // Byte for byte the stored artifact; yazl reads it during the
        // pipe, and a vanished or replaced file fails the whole
        // assembly (a refusal), never a silently thinner archive.
        await archive.addFile(path.join(dataDir(), t.file), entry);
        continue;
      }
      let converted: Awaited<ReturnType<typeof exportTable>>;
      try {
        // Addressed by identity: never a same-named dataset of the caller's.
        converted = await exportTable(scope, t.id, effective);
      } catch (e) {
        rethrowStorageFailure(e);
        if (e instanceof AuthError || isTrustedOperationRefusal(e)) throw e;
        throw new ApiError(
          "export_failed",
          `The dataset "${t.qualifiedName}" could not be written as ` +
            `${effective === "csv" ? "CSV" : "GeoJSON"}: ${
              e instanceof Error ? e.message : "unknown failure"
            }`,
          500,
        );
      }
      conversions.push(converted);
      await archive.addFile(converted.path, entry);
    }

    // A tracked pass: artifact retirement waits for assembly.
    await trackInflight(archive.finish(staged));
    await cleanConversions();
    const { size } = await stat(staged);
    requireProject(scope, projectId);
    requireSelectionInReach(scope, projectId, [
      ...mapDocs.map((m) => ({ kind: "map" as const, id: m.id, name: m.name })),
      ...workflowDocs.map((w) => ({ kind: "workflow" as const, id: w.id, name: w.name })),
      ...chosenTables.map((t) => ({ kind: "dataset" as const, id: t.id, name: t.qualifiedName })),
    ]);
    operation.assertCanCommit();
    return { path: staged, filename: `${base}.zip`, size };
  } catch (e) {
    const refusal = isStorageExhausted(e) ? storageExhausted() : isTrustedOperationRefusal(e) || e instanceof AuthError ? e : new ApiError(
      "export_failed",
      `The archive could not be assembled: ${e instanceof Error ? e.message : "unknown failure"}`,
      500,
    );
    operation.refuse(refusal);
    await archive.close();
    await observeDeletionCleanup(async () => {
      await removeAccountFile(staged, { force: true });
      await cleanConversions();
    });
    throw refusal;
  }
}

export function assembleProjectExport(scope: AccountScope, projectId: string, selection: ProjectExportSelection, signal?: AbortSignal): Promise<PreparedProjectExport> {
  return withTrustedMutation({ kind: "export", name: "Project export", signal }, async operation => {
  const result = await copyFileWork(scope, [{ table: "projects", id: projectId }], async () => {
    const file = await assembleProjectExportWork(scope, projectId, selection);
    return { ...file, cleanup: () => removeAccountFile(file.path, { force: true }) };
  });
  operation.defer(async () => { if (operation.signal.aborted) await result.cleanup(); });
  operation.assertCanCommit();
  return result;
  });
}

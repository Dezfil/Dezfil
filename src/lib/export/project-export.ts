import { AuthError } from "@/lib/auth/errors";
import type { AccountScope } from "@/lib/auth/scope";
import { requireOwnedResource } from "@/lib/auth/owned-resource";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ZipFile } from "yazl";
import { ApiError } from "@/lib/api/errors";
import { dataDir } from "@/lib/config";
import type { DataTable } from "@/lib/metadata/tables";
import { listOwnedTables } from "@/lib/metadata/owned-tables";
import { projectMemberIds, requireProject } from "@/lib/metadata/owned-projects";
import { mapWithLayers } from "@/lib/map-service";
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
 * Assemble the 16-C archive: validate through the read-only member
 * preflight, project every chosen member, and write one zip to a
 * temporary file under the data directory — finalized on disk before
 * any success is claimed, so a failed assembly is a refusal and never a
 * truncated 200. The caller owns the returned file's
 * lifetime (the ticket store deletes it on redeem, expiry or failure).
 */
export async function assembleProjectExport(
  scope: AccountScope,
  projectId: string,
  selection: ProjectExportSelection,
): Promise<PreparedProjectExport> {
  requireOwnedResource(scope, "project", projectId);
  const project = requireProject(scope, projectId);
  const members = projectMemberIds(scope, projectId);
  for (const id of selection.maps) requireOwnedResource(scope, "map", id);
  for (const id of selection.recipes) requireOwnedResource(scope, "workflow", id);
  for (const id of selection.tables) requireOwnedResource(scope, "dataset", id);
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
  const byId = new Map(listOwnedTables(scope).map((t) => [t.id, t]));
  const chosenTables = tables
    .map((id) => byId.get(id))
    .filter((t): t is DataTable => t !== undefined);

  const mapDocs = maps.map((id) => {
    const wire = mapWithLayers(scope, id) as unknown as Record<string, unknown>;
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
        file: `datasets/${datasetFileName(t.name, requestedFormat, t.geometryColumn !== null)}`,
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
        `The dataset "${t.name}" has no stored artifact to export.`,
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
      if (age > 15 * 60_000) await rm(p, { force: true });
    }
  } catch {
    // The sweep is best-effort; assembly proceeds regardless.
  }
  const staged = path.join(stagingDir, `${randomUUID()}.zip`);

  const zip = new ZipFile();
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
    await Promise.all(
      conversions.splice(0).map((c) => c.cleanup().catch(() => {})),
    );
  };
  try {
    for (const t of chosenTables) {
      const spatial = t.geometryColumn !== null;
      const effective = effectiveDatasetFormat(requestedFormat, spatial);
      const entry = `${root}/datasets/${datasetFileName(t.name, requestedFormat, spatial)}`;
      if (effective === "geoparquet") {
        // Byte for byte the stored artifact; yazl reads it during the
        // pipe, and a vanished or replaced file fails the whole
        // assembly (a refusal), never a silently thinner archive.
        zip.addFile(path.join(dataDir(), t.file), entry);
        continue;
      }
      let converted: Awaited<ReturnType<typeof exportTable>>;
      try {
        converted = await exportTable(scope, t.name, effective);
      } catch (e) {
        if (e instanceof AuthError || (e instanceof ApiError && e.code === "not_found")) throw e;
        throw new ApiError(
          "export_failed",
          `The dataset "${t.name}" could not be written as ` +
            `${effective === "csv" ? "CSV" : "GeoJSON"}: ${
              e instanceof Error ? e.message : "unknown failure"
            }`,
          500,
        );
      }
      conversions.push(converted);
      zip.addFile(converted.path, entry);
    }

    // A tracked pass: artifact retirement waits for assembly.
    await trackInflight(
      new Promise<void>((resolve, reject) => {
        const out = createWriteStream(staged);
        out.on("error", reject);
        out.on("close", resolve);
        zip.outputStream.on("error", reject);
        zip.outputStream.pipe(out);
        zip.end();
      }),
    );
    await cleanConversions();
    const { size } = await stat(staged);
    requireProject(scope, projectId);
    return { path: staged, filename: `${base}.zip`, size };
  } catch (e) {
    await rm(staged, { force: true });
    await cleanConversions();
    if (e instanceof ApiError || e instanceof AuthError) throw e;
    throw new ApiError(
      "export_failed",
      `The archive could not be assembled: ${
        e instanceof Error ? e.message : "unknown failure"
      }`,
      500,
    );
  }
}

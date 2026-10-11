import type { Database } from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { admitAccountWork, type AccountWorkLease } from "@/lib/auth/account-deletion-admission";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { deriveTableName } from "@/lib/ingest/naming";
import { saveThemedThumbnail } from "@/lib/map-thumbnails";
import { metadataDb } from "@/lib/metadata/db";
import { insertLayer, insertMap } from "@/lib/metadata/maps";
import { createProject, fileMap } from "@/lib/metadata/owned-projects";
import { fileOwnedTable } from "@/lib/metadata/owned-tables";
import { projectName } from "@/lib/metadata/projects";
import { readDocumentRevision, recordDocumentBatch } from "@/lib/metadata/revisions";
import { insertTable } from "@/lib/metadata/tables";
import { takenNames } from "@/lib/operations/recipe-duplicate";
import { projectMembers, projectOverview, type ProjectMembers, type ProjectOverview } from "@/lib/project-service";
import { trackInflight } from "@/lib/query/inflight";
import { captureInputs, currentMapRevision } from "@/lib/thumbnail-evidence";
import type { AdmittedMap } from "./admission";
import { copySource, type CopySource } from "./catalogue";
import { copyDatasetFile, removeCopiedArtifacts, type CopiedArtifact } from "./copy-artifacts";
import { bindCopyReferences, type CopyReferences } from "./copy-references";
import { TEMPLATE_THEMES, type TemplateFacts, type TemplateTheme } from "./format";
import { readInstalledVersion, type InstalledVersion } from "./installed";
import { refuse } from "./refusals";

/**
 * Making a copy of a template: all of it, or nothing.
 *
 * The copy reads an installed version (the one named, else the installed
 * one) as an in-flight reader of its folder. Before any write, every
 * reference its documents make is bound to the datasets the copy makes,
 * or the copy is refused whole. Each dataset (and each bundled result) is
 * then copied byte for byte into a fresh artifact of the copier's, owned
 * from before its first byte, the copy admitted as the account's work, so
 * a deletion accepted meanwhile stops it with nothing registered.
 *
 * Then one metadata transaction, the project first: the project with its
 * provenance line; the names, allocated inside the transaction by the
 * suffix rule against the copier's datasets and every output name their
 * workflows declare, so two copies at once by one account each take names
 * the other has already taken; the datasets, theirs, with source
 * `template` naming the id and version, filed in the project; the map
 * under fresh identities, its SQL naming the datasets as landed and its
 * widgets, legend order and timeline bound to the copied layers, filed in
 * the project. A failure anywhere before the commit rolls back the project
 * and removes every artifact the copy made.
 *
 * The card images are saved after the commit, through the map's own
 * thumbnail road, which needs the map to exist and be the caller's: the
 * template's pictures, with evidence naming the copied datasets. A failure
 * there leaves the copy whole and its card on the placeholder until the
 * map's first capture.
 */

export interface CopyRequest {
  /** The project's name; the template's title when absent. */
  name?: string;
  /** The version to copy; the installed one when absent. */
  version?: number | null;
}

export interface TemplateCopy {
  project: ProjectOverview;
  members: ProjectMembers;
}

/** A seam for tests: told of each copy at the step before its transaction,
 * by `<id>@<version>`, which waits for what it answers. */
export interface CopySeam {
  beforeTransaction?(key: string): void | Promise<void>;
}

const SEAM = Symbol.for("dezfil.template-copy-seam");
const host = globalThis as typeof globalThis & { [SEAM]?: { seam: CopySeam } };
const holder = host[SEAM] ??= { seam: {} };

export function setCopySeamForTests(seam: CopySeam | null): void {
  holder.seam = seam ?? {};
}

/** A dataset or bundled result the copy lands, with its file in the
 * version folder. */
interface CopiedMember {
  name: string;
  file: string;
}

interface Made {
  projectId: string;
  mapId: string;
  pictures: Record<TemplateTheme, Buffer>;
}

function provenance(facts: TemplateFacts, note: string | null, now: string): string {
  const line = `Copied from the template ${facts.title} (${facts.id}), version ${facts.version}, on ${now.slice(0, 10)}.`;
  return note ? `${line}\n\n${note}` : line;
}

/** The map, under fresh identities, everything that names a layer bound to
 * the copied one; filed in the project. Answers its id. */
function writeMap(scope: AccountScope, map: AdmittedMap, sql: string[], projectId: string, now: string, db: Database): string {
  const mapId = randomUUID();
  const layerIds = new Map(map.layers.map((layer) => [layer.id, randomUUID()]));
  // The admission held every layer reference to a layer of this map.
  const layerId = (id: string) => layerIds.get(id)!;
  insertMap(scope, {
    id: mapId,
    name: map.name,
    viewport: map.viewport,
    basemap: map.basemap,
    customBasemap: null,
    basemapLayers: map.basemapLayers,
    note: null,
    legendCorner: map.legendCorner,
    legendOrder: map.legendOrder?.map(layerId) ?? null,
    timeline: map.timeline ? { ...map.timeline, layerId: layerId(map.timeline.layerId) } : null,
    widgets: map.widgets.map((widget) => ({ ...widget, id: randomUUID(), layerId: widget.layerId === null ? null : layerId(widget.layerId) })),
    widgetsPublished: map.widgetsPublished,
    publishToken: null,
    publishedAt: null,
    published: false,
    createdAt: now,
    updatedAt: now,
  }, db);
  map.layers.forEach((layer, ordinal) => {
    insertLayer({ ...layer, id: layerId(layer.id), mapId, sql: sql[ordinal], ordinal, createdAt: now, updatedAt: now }, db);
  });
  fileMap(scope, mapId, projectId, db, { expectedRevision: readDocumentRevision({ kind: "map", id: mapId }, db)!.editRevision });
  return mapId;
}

interface Planned {
  installed: InstalledVersion;
  references: CopyReferences;
  members: CopiedMember[];
  copied: CopiedArtifact[];
  name: string;
}

/** Everything the copy writes, inside its one transaction, the project
 * first. */
function writeCopy(scope: AccountScope, accountId: string, planned: Planned, db: Database): Omit<Made, "pictures"> {
  const { installed: { admitted, record }, references, members, copied } = planned;
  const { facts } = admitted;
  const now = new Date().toISOString();
  const project = createProject(scope, { name: planned.name, note: provenance(facts, admitted.manifest.project.note, now) }, db);
  // Taken here, under the transaction: what another copy committed before
  // this one began is already among them.
  const taken = takenNames(scope, db, accountId);
  const landed = new Map<string, string>();
  members.forEach((member, i) => {
    const name = deriveTableName(member.name, taken);
    taken.add(name);
    landed.set(member.name.toLowerCase(), name);
    const measured = record.measured[member.file];
    insertTable(scope, {
      id: copied[i].id,
      name,
      sourceFilename: null,
      format: "geoparquet",
      file: copied[i].file,
      geometryColumn: measured.geometryColumn,
      geometryType: measured.geometryType,
      crsAssumed: measured.crsAssumed,
      headerSuspect: false,
      rowCount: measured.rowCount,
      createdAt: now,
      source: "template",
      sourceParams: { template: facts.id, version: facts.version },
      importedAt: now,
    }, db);
    fileOwnedTable(scope, copied[i].id, project.id, db);
  });
  const mapId = writeMap(scope, admitted.map, references.layerSql(landed), project.id, now, db);
  return { projectId: project.id, mapId };
}

async function makeCopy(scope: AccountScope, accountId: string, source: CopySource, name: string | null, lease: AccountWorkLease, db: Database): Promise<Made> {
  const installed = await readInstalledVersion(source.folder);
  const { admitted, record } = installed;
  if (admitted.facts.id !== source.id || admitted.facts.version !== source.version) {
    refuse("template_record_mismatch", `The installed folder of ${source.id} version ${source.version} holds another version.`);
  }
  const references = await bindCopyReferences(scope, admitted);
  const pictures = Object.fromEntries(await Promise.all(TEMPLATE_THEMES.map(async (theme) =>
    [theme, await readFile(path.join(admitted.folder, admitted.pictures[theme]))] as const))) as Record<TemplateTheme, Buffer>;
  const members: CopiedMember[] = [
    ...admitted.datasets.map((dataset) => ({ name: dataset.name, file: dataset.file })),
    ...(admitted.workflow?.steps ?? []).map((step) => ({ name: step.output, file: step.result })),
  ];
  const copied: CopiedArtifact[] = [];
  try {
    for (const member of members) {
      copied.push(await copyDatasetFile(accountId, admitted.folder, member.file, record.files[member.file].sha256));
    }
    await holder.seam.beforeTransaction?.(`${source.id}@${source.version}`);
    const planned: Planned = { installed, references, members, copied, name: name ?? projectName(admitted.facts.title) };
    const made = db.transaction(() => recordDocumentBatch(scope, () => {
      lease.assertCommit();
      return writeCopy(scope, accountId, planned, db);
    }, db)).immediate();
    return { ...made, pictures };
  } catch (error) {
    await removeCopiedArtifacts(copied);
    throw error;
  }
}

/** The card images, after the commit: the template's pictures as the
 * map's themed pair, with evidence naming what its layers bind. A failure
 * leaves the copy as it is, its card on the placeholder. */
async function savePictures(scope: AccountScope, made: Made): Promise<void> {
  try {
    const inputs = await captureInputs(scope, made.mapId, currentMapRevision(made.mapId));
    const cycle = randomBytes(12).toString("hex");
    for (const theme of TEMPLATE_THEMES) await saveThemedThumbnail(scope, made.mapId, theme, cycle, made.pictures[theme], inputs);
  } catch {
    // The copy is whole without its card images; the first capture draws them.
  }
}

/** Make a copy of a template's version into a new project of the caller's.
 * Answers the project with its members. */
export async function copyTemplate(scope: AccountScope, id: string, request: CopyRequest = {}, db: Database = metadataDb()): Promise<TemplateCopy> {
  const accountId = requireAccountScope(scope, db);
  const name = request.name === undefined ? null : projectName(request.name);
  const source = await copySource(id, request.version ?? null, db);
  const lease = admitAccountWork([accountId], db);
  let made: Made;
  try {
    made = await trackInflight(makeCopy(scope, accountId, source, name, lease, db));
  } finally {
    lease.release();
  }
  await savePictures(scope, made);
  return { project: await projectOverview(scope, made.projectId), members: await projectMembers(scope, made.projectId) };
}

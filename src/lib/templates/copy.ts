import { notifyPicture } from "@/lib/pictures/hooks";
import type { Database } from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { admitAccountWork, type AccountWorkLease } from "@/lib/auth/account-deletion-admission";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { BASEMAPS, type BasemapKey } from "@/lib/basemap";
import { checkInstanceCreationLimit } from "@/lib/instance-limit-admission";
import { saveThemedThumbnail } from "@/lib/map-thumbnails";
import { metadataDb } from "@/lib/metadata/db";
import { insertLayer, insertMap } from "@/lib/metadata/maps";
import { createProject, fileMap, fileRecipe } from "@/lib/metadata/owned-projects";
import { addStep } from "@/lib/metadata/owned-recipes";
import { fileOwnedTable } from "@/lib/metadata/owned-tables";
import { projectName } from "@/lib/metadata/projects";
import { putLayout } from "@/lib/metadata/recipe-layouts";
import { recordOutput } from "@/lib/metadata/recipe-outputs";
import { createRecipe } from "@/lib/metadata/recipes";
import { readDocumentRevision, recordDocumentBatch } from "@/lib/metadata/revisions";
import { insertTable } from "@/lib/metadata/tables";
import { takenNames } from "@/lib/operations/recipe-duplicate";
import type { DrawnBasemap } from "@/lib/picture-credit";
import { projectMembers, projectOverview, type ProjectMembers, type ProjectOverview } from "@/lib/project-service";
import { trackInflight } from "@/lib/query/inflight";
import { captureInputs, currentMapRevision } from "@/lib/thumbnail-evidence";
import type { AdmittedMap, AdmittedWorkflow } from "./admission";
import { copySource, type CopySource } from "./catalogue";
import { copyDatasetFile, removeCopiedArtifacts, type CopiedArtifact } from "./copy-artifacts";
import { bindCopyReferences, type CopyReferences, type LandedNames } from "./copy-references";
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
 * The names are taken by the suffix rule against the copier's datasets and
 * every output name their workflows declare, never on a word the
 * template's queries use (copy-references.ts), and the rewrite under
 * exactly those names is checked before the transaction. The transaction
 * takes them again: names another copy or upload committed meanwhile are
 * among what it finds, so two copies at once by one account each take
 * names the other has already taken. Should they differ from the checked
 * ones, it writes nothing, and the copy checks the new names and runs it
 * again.
 *
 * Then one metadata transaction, the project first: the project with its
 * provenance line; the datasets, theirs, with source `template` naming
 * the id and version, filed in the project; the map under fresh
 * identities, its SQL naming the datasets as landed and its widgets,
 * legend order and timeline bound to the copied layers, filed in the
 * project; and a workflow example's workflow, each step its own,
 * reading and declaring the names as landed, each bundled result recorded
 * as the copier's output of its step with no job and no run (the record's
 * time is the copy's), its canvas layout with every position under the
 * copy's step or the dataset as landed and every note, filed in the
 * project. A failure anywhere before the commit rolls back the project and
 * removes every artifact the copy made.
 *
 * The card images are saved after the commit, through the map's own
 * thumbnail road, which needs the map to exist and be the caller's: the
 * template's pictures, with evidence naming the copied datasets and the
 * basemap the template drew them on. A failure there leaves the copy whole
 * and its card on the placeholder until the map's first capture.
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
  /** The basemap the template's map is on, which its pictures were drawn on. */
  basemap: BasemapKey | null;
}

function provenance(facts: TemplateFacts, note: string | null, now: string): string {
  const line = `Copied from the template ${facts.title}, version ${facts.version}, on ${now.slice(0, 10)}.`;
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

/** The workflow, its steps the copier's own, each bundled result recorded
 * as the copier's output of its step by no job and no run, and its layout
 * rebound; filed in the project. */
function writeWorkflow(
  scope: AccountScope,
  accountId: string,
  workflow: AdmittedWorkflow,
  copy: { parameters: Record<string, unknown>[]; results: { id: string; name: string }[]; landed: LandedNames },
  projectId: string,
  now: string,
  db: Database,
): void {
  const recipe = createRecipe(scope, workflow.name, db, workflow.origin);
  const revision = () => readDocumentRevision({ kind: "workflow", id: recipe.id }, db)!.editRevision;
  fileRecipe(scope, recipe.id, projectId, db, { expectedRevision: revision() });
  const stepIds = new Map<string, string>();
  workflow.steps.forEach((step, i) => {
    const added = addStep(scope, recipe.id, { operation: step.operation, parameters: copy.parameters[i], origin: null }, db, { expectedRevision: revision() });
    stepIds.set(step.id, added.id);
    // The bundled result as the copier's output of the step, recorded as a
    // run's output is, by no job and no run: the workflow reads it as a
    // copied result until the step's first run replaces it.
    recordOutput(added.id, copy.results[i], now, db, { accountId, jobId: null, runId: null });
  });
  const rebound = <T>(entries: Record<string, T>, to: (key: string) => string | undefined) =>
    Object.fromEntries(Object.entries(entries).flatMap(([key, value]) => {
      const next = to(key);
      return next === undefined ? [] : [[next, value]];
    }));
  putLayout(recipe.id, {
    steps: rebound(workflow.layout.steps, (id) => stepIds.get(id)),
    // A source is placed by its dataset's name: the name as landed.
    sources: rebound(workflow.layout.sources, (name) => copy.landed.get(name.toLowerCase())),
    notes: workflow.layout.notes,
  }, db);
}

interface Planned {
  installed: InstalledVersion;
  references: CopyReferences;
  members: CopiedMember[];
  copied: CopiedArtifact[];
  name: string;
  /** The names the rewrite was checked under. */
  landed: LandedNames;
}

/** The names a copy checked moved before its transaction took them: the
 * transaction wrote nothing, and these are the names it found. */
class NamesMoved extends Error {
  constructor(readonly landed: LandedNames) {
    super("The copy's dataset names changed before its transaction.");
  }
}

/** How many times a copy checks names that moved under it before it gives
 * up: each move is another write of the copier's committing first. */
const NAME_ATTEMPTS = 5;

const sameNames = (a: LandedNames, b: LandedNames) => a.size === b.size && [...a].every(([key, name]) => b.get(key) === name);

/** Everything the copy writes, inside its one transaction, the project
 * first. */
function writeCopy(scope: AccountScope, accountId: string, planned: Planned, db: Database): Omit<Made, "pictures" | "basemap"> {
  const { installed: { admitted, record }, references, members, copied, landed } = planned;
  // Taken again here, under the transaction: what another copy committed
  // since the names were checked is among them now.
  const now = references.land(takenNames(scope, db, accountId));
  if (!sameNames(now, landed)) throw new NamesMoved(now);
  const { facts } = admitted;
  const at = new Date().toISOString();
  const project = createProject(scope, { name: planned.name, note: provenance(facts, admitted.manifest.project.note, at) }, db);
  members.forEach((member, i) => {
    const name = landed.get(member.name.toLowerCase())!;
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
      createdAt: at,
      source: "template",
      sourceParams: { template: facts.id, version: facts.version },
      importedAt: at,
    }, db);
    fileOwnedTable(scope, copied[i].id, project.id, db);
  });
  const mapId = writeMap(scope, admitted.map, references.layerSql(landed), project.id, at, db);
  const { workflow } = admitted;
  if (workflow) {
    // The bundled results land after the datasets, in the steps' order.
    const results = workflow.steps.map((step, i) => ({
      id: copied[admitted.datasets.length + i].id,
      name: landed.get(step.output.toLowerCase())!,
    }));
    writeWorkflow(scope, accountId, workflow, { parameters: references.stepParameters(landed), results, landed }, project.id, at, db);
  }
  return { projectId: project.id, mapId };
}

async function makeCopy(scope: AccountScope, accountId: string, source: CopySource, name: string | null, lease: AccountWorkLease, db: Database): Promise<Made> {
  checkInstanceCreationLimit("projects", db);
  checkInstanceCreationLimit("maps", db);
  const installed = await readInstalledVersion(source.folder);
  const { admitted, record } = installed;
  if (admitted.facts.id !== source.id || admitted.facts.version !== source.version) {
    refuse("template_record_mismatch", `The installed folder of ${source.id} version ${source.version} holds another version.`);
  }
  const references = await bindCopyReferences(scope, admitted);
  let landed = references.land(takenNames(scope, db, accountId));
  await references.check(landed);
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
    for (let attempt = 1; ; attempt++) {
      const planned: Planned = { installed, references, members, copied, name: name ?? projectName(admitted.facts.title), landed };
      try {
        const made = db.transaction(() => recordDocumentBatch(scope, () => {
          lease.assertCommit();
          return writeCopy(scope, accountId, planned, db);
        }, db)).immediate();
        return { ...made, pictures, basemap: admitted.map.basemap };
      } catch (error) {
        if (!(error instanceof NamesMoved) || attempt === NAME_ATTEMPTS) throw error;
        landed = error.landed;
        await references.check(landed);
      }
    }
  } catch (error) {
    await removeCopiedArtifacts(copied);
    throw error;
  }
}

/**
 * The basemap a template's picture was drawn on, recorded with it. The
 * pictures are saved as they came rather than drawn here, so they keep the
 * credit of what they were drawn on, not this instance's basemap, whose
 * deployment may set a style of its own. A template names no basemap
 * beyond its map's key: on Auto or a built-in style it was drawn on the
 * built-in style for the picture's theme, with the built-in credit. On
 * Satellite it names no imagery and no credit, so its pictures record none
 * and are credited by the copied map's basemap, as a picture with no
 * record is.
 */
function templatePictureBasemap(key: BasemapKey | null, theme: TemplateTheme): DrawnBasemap | null {
  if (key === "satellite") return null;
  const style = BASEMAPS.find((b) => b.key === (key ?? theme))!;
  return { url: style.url, kind: style.kind, custom: false, attribution: style.attribution };
}

/** The card images, after the commit: the template's pictures as the
 * map's themed pair, marked as the template's, with evidence naming what
 * its layers bind and the basemap they were drawn on. A failure leaves the
 * copy as it is, its card on the placeholder. */
async function savePictures(scope: AccountScope, made: Made): Promise<void> {
  try {
    const inputs = await captureInputs(scope, made.mapId, currentMapRevision(made.mapId));
    const cycle = randomBytes(12).toString("hex");
    for (const theme of TEMPLATE_THEMES) {
      await saveThemedThumbnail(scope, made.mapId, theme, cycle, made.pictures[theme], inputs, templatePictureBasemap(made.basemap, theme), "template");
    }
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
  notifyPicture(made.mapId, { inherited: true });
  return { project: await projectOverview(scope, made.projectId), members: await projectMembers(scope, made.projectId) };
}

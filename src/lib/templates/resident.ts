import { createHash } from "node:crypto";
import { readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { ApiError } from "@/lib/api/errors";
import type { LayoutDocument } from "@/lib/metadata/recipe-layouts";
import { normalizeLayout } from "@/lib/operations/layout-document";
import type { TemplateHome, TemplateMount } from "@/lib/query/context";
import { FACTS_FILE, MANIFEST_FILE, RESULTS_FOLDER, TEMPLATE_DOCUMENT_MAX_BYTES, factsProblem, type TemplateFacts } from "./format";
import { stageTemplateArtifact, templateArtifactName } from "./home";
import { templateDocumentId } from "./ids";
import { admitMapDocument, type AdmittedMap } from "./map-document";
import { downloadedTemplatesDir, RECORD_FILE, recordProblem, type InstalledRecord } from "./record";
import { provideTemplateDocuments } from "./resolver";
import { readShippedIndexSync, shippedTemplatesDir, SHIPPED_INDEX_FILE } from "./shipped-index";

/**
 * A template version as its map is read: the installed folder's documents,
 * answered in the turn they are asked for, with the home its SQL binds in.
 *
 * A version is found where the shipped set or the downloads hold it (a
 * shipped id has its shipped version alone). It is read whole against its
 * record: the record well formed and of this version, each document's
 * bytes the record's by size and checksum, each dataset and bundled result
 * of the size the record gives and measured by it, the facts of this
 * version, and the map under the map write's rules again. The datasets'
 * own checksums are held when they are first made present for the engine
 * (the home's staging), which reads their bytes anyway. Anything that does
 * not read so is no version: its map answers as a missing one.
 *
 * Read once per process and kept while the folder's record and the shipped
 * index are the files they were, so a version replaced on disk, or removed,
 * is read again or no longer found.
 */

export interface ResidentStep {
  id: string;
  /** The operation it runs, by its id in the catalogue. */
  operation: string;
  /** Its parameters as the workflow document holds them. */
  parameters: Record<string, unknown>;
  /** The registered name of the dataset the step makes. */
  output: string;
  /** Its bundled result, relative to the version folder. */
  result: string;
}

export interface ResidentTemplate {
  id: string;
  version: number;
  folder: string;
  shipped: boolean;
  record: InstalledRecord;
  facts: TemplateFacts;
  map: AdmittedMap;
  /** The map document's own times, as it was exported. */
  createdAt: string;
  updatedAt: string;
  workflow: {
    id: string;
    name: string;
    steps: ResidentStep[];
    layout: LayoutDocument;
    /** When the arrangement was last written before the export; null for
     * one never written, which the canvas arranges by itself. */
    layoutUpdatedAt: string | null;
  } | null;
  home: TemplateHome;
}

interface Kept {
  signature: string;
  resident: ResidentTemplate;
}

const kept = new Map<string, Kept>();

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Unread extends Error {}

function unread(message: string): never {
  throw new Unread(message);
}

function statOf(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

const stamp = (stats: Stats | null) => (stats ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}` : "none");

/** A document member, its bytes held to the record's. */
function documentOf(folder: string, record: InstalledRecord, member: string): unknown {
  const entry = record.files[member];
  if (!entry || entry.bytes > TEMPLATE_DOCUMENT_MAX_BYTES) unread(`The record does not give "${member}" as a document.`);
  const bytes = readFileSync(path.join(folder, member));
  if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    unread(`"${member}" differs from its record.`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

/** A dataset or bundled result: present at the record's size and measured. */
function dataOf(folder: string, record: InstalledRecord, member: string): void {
  const entry = record.files[member];
  if (!entry || !record.measured[member]) unread(`The record does not give "${member}" as data.`);
  if (statOf(path.join(folder, member))?.size !== entry.bytes) unread(`"${member}" differs from its record.`);
}

const timeOf = (value: unknown, fallback: string) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;

function read(id: string, version: number, folder: string, shipped: boolean, recordStats: Stats): ResidentTemplate {
  if (recordStats.size > TEMPLATE_DOCUMENT_MAX_BYTES) unread("The record is larger than a document may be.");
  const raw: unknown = JSON.parse(readFileSync(path.join(folder, RECORD_FILE), "utf8"));
  const problem = recordProblem(raw);
  if (problem) unread(problem);
  const record = raw as InstalledRecord;
  if (record.id !== id || record.version !== version) unread("The record is of another version.");

  const manifest = documentOf(folder, record, MANIFEST_FILE);
  const facts = documentOf(folder, record, FACTS_FILE);
  if (factsProblem(facts) !== null) unread("The facts do not read.");
  const read = facts as TemplateFacts;
  if (read.id !== id || read.version !== version) unread("The facts are of another version.");
  if (!isObject(manifest) || !isObject(manifest.contents)) unread("The manifest does not read.");
  const contents = manifest.contents as Record<string, unknown>;
  const entries = (kind: string) => (Array.isArray(contents[kind]) ? (contents[kind] as unknown[]).filter(isObject) : []);
  const [mapEntry] = entries("maps");
  const [workflowEntry] = entries("workflows");
  if (!mapEntry || typeof mapEntry.file !== "string") unread("The manifest names no map.");
  const mapRaw = documentOf(folder, record, mapEntry.file);
  const map = admitMapDocument(mapRaw, mapEntry.file);
  const fallback = new Date(recordStats.mtimeMs).toISOString();
  const createdAt = timeOf(isObject(mapRaw) ? mapRaw.createdAt : null, fallback);
  const updatedAt = timeOf(isObject(mapRaw) ? mapRaw.updatedAt : null, createdAt);

  const datasets = entries("datasets").map((d) => {
    if (typeof d.name !== "string" || typeof d.file !== "string") unread("A dataset entry does not read.");
    dataOf(folder, record, d.file);
    return { name: d.name, file: d.file };
  });

  let workflow: ResidentTemplate["workflow"] = null;
  if (workflowEntry) {
    if (typeof workflowEntry.file !== "string") unread("The manifest's workflow does not read.");
    const document = documentOf(folder, record, workflowEntry.file);
    if (!isObject(document) || !Array.isArray(document.steps)) unread("The workflow does not read.");
    const steps = (document.steps as unknown[]).map((step): ResidentStep => {
      if (!isObject(step) || typeof step.id !== "string" || typeof step.operation !== "string" ||
        !isObject(step.parameters) || typeof step.parameters.name !== "string") {
        unread("A step does not read.");
      }
      const result = `${RESULTS_FOLDER}/${step.id}.parquet`;
      dataOf(folder, record, result);
      return { id: step.id, operation: step.operation, parameters: { ...step.parameters }, output: step.parameters.name, result };
    });
    // The canvas arrangement under the layout document's own rule, as the
    // admission read it at install.
    const layout = normalizeLayout(document.layout ?? {}, new Set(steps.map((s) => s.id)));
    const written = isObject(document.layout) ? document.layout.updatedAt : null;
    const layoutUpdatedAt = typeof written === "string" && !Number.isNaN(Date.parse(written)) ? written : null;
    workflow = { id: String(document.id), name: String(document.name), steps, layout, layoutUpdatedAt };
  }

  const members: [string, string][] = [];
  const mount = (member: string, kind: "dataset" | "result", part: string, name: string): TemplateMount => {
    const file = record.files[member];
    const measured = record.measured[member];
    members.push([member, file.sha256]);
    return {
      id: templateDocumentId({ template: id, version, kind, part }),
      name,
      file: templateArtifactName(file.sha256),
      geometryColumn: measured.geometryColumn,
      geometryType: measured.geometryType,
      rowCount: measured.rowCount,
      crsAssumed: measured.crsAssumed,
    };
  };
  const home: TemplateHome = {
    template: id,
    version,
    datasets: datasets.map((d) => mount(d.file, "dataset", d.name, d.name)),
    outputs: (workflow?.steps ?? []).map((s) => mount(s.result, "result", s.id, s.output)),
    // Each file is made present for the engine under its content's name,
    // its bytes held to the record's checksum the first time.
    stage: async () => {
      for (const [member, sha256] of members) {
        await stageTemplateArtifact(path.join(folder, member), sha256, { verify: true });
      }
    },
  };
  return { id, version, folder, shipped, record, facts: read, map, createdAt, updatedAt, workflow, home };
}

/**
 * The installed version of `id` at `version`, read; null when none is
 * installed or the folder does not read as one.
 */
export function residentTemplate(id: string, version: number): ResidentTemplate | null {
  const index = readShippedIndexSync(shippedTemplatesDir());
  const listed = index?.templates.find((t) => t.id === id);
  if (listed && listed.version !== version) return null;
  const shipped = listed !== undefined;
  const folder = path.join(shipped ? shippedTemplatesDir() : downloadedTemplatesDir(), id, String(version));
  const recordStats = statOf(path.join(folder, RECORD_FILE));
  const key = `${id}@${version}`;
  if (!recordStats) {
    kept.delete(key);
    return null;
  }
  const signature = `${folder}|${stamp(recordStats)}|${shipped ? stamp(statOf(path.join(shippedTemplatesDir(), SHIPPED_INDEX_FILE))) : ""}`;
  const known = kept.get(key);
  if (known?.signature === signature) return known.resident;
  try {
    const resident = read(id, version, folder, shipped, recordStats);
    kept.set(key, { signature, resident });
    return resident;
  } catch (error) {
    kept.delete(key);
    // A fault of the folder (a missing or changed member, a document that
    // is not JSON, a map the write's rules refuse) is no version; anything
    // else is this server's own failure.
    if (error instanceof Unread || error instanceof SyntaxError || error instanceof ApiError) return null;
    if (typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).syscall) return null;
    throw error;
  }
}

provideTemplateDocuments({
  present(ref) {
    const resident = residentTemplate(ref.template, ref.version);
    if (!resident) return false;
    if (ref.kind === "map") return true;
    return ref.kind === "layer" && resident.map.layers.some((layer) => layer.id === ref.part);
  },
  home(ref) {
    return ref.kind === "map" ? residentTemplate(ref.template, ref.version)?.home ?? null : null;
  },
});

/** Forget what this process keeps: for a test's fresh start. */
export function resetResidentTemplatesForTests(): void {
  kept.clear();
}

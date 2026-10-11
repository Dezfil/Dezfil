import path from "node:path";
import { dataDir } from "@/lib/config";
import { isTemplateVersion } from "./ids";

/**
 * The installed form's record, as data: what an installed version folder
 * says of itself, and where downloaded versions live.
 *
 * Kept apart from the installed form's reading (installed.ts), which reads
 * a folder back through the first stage of the admission, so that the
 * template's documents can be answered from a folder by modules the
 * admission's own roads depend on.
 */

export const RECORD_FILE = "record.json";

/** Where downloaded versions are installed: the data folder's `templates/`,
 * one folder per version at `<id>/<version>/`. */
export function downloadedTemplatesDir(): string {
  return path.join(dataDir(), "templates");
}
export const RECORD_FORMAT_VERSION = 1;

export type InstalledOrigin =
  | { kind: "shipped" }
  | { kind: "catalogue"; origin: string }
  | { kind: "folder" };

/** What the dataset reader measured of one dataset or bundled result. */
export interface DatasetMeasurement {
  rowCount: number;
  geometryColumn: string | null;
  geometryType: string | null;
  crsAssumed: boolean;
}

export interface InstalledRecord {
  formatVersion: number;
  id: string;
  version: number;
  archive: { sha256: string; size: number };
  origin: InstalledOrigin;
  /** Every member but the record, by its path in the folder. */
  files: Record<string, { bytes: number; sha256: string }>;
  /** Each dataset and bundled result, by its path in the folder. */
  measured: Record<string, DatasetMeasurement>;
}

const SHA256 = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function originProblem(value: unknown): string | null {
  if (!isObject(value)) return "its origin must be an object.";
  if (value.kind === "shipped" || value.kind === "folder") {
    return Object.keys(value).length === 1 ? null : "its origin carries more than its kind.";
  }
  if (value.kind === "catalogue") {
    if (Object.keys(value).length !== 2 || typeof value.origin !== "string") return "a catalogue origin names its scheme and host alone.";
    try {
      const url = new URL(value.origin);
      return url.origin === value.origin ? null : "a catalogue origin names its scheme and host alone.";
    } catch {
      return "a catalogue origin names its scheme and host alone.";
    }
  }
  return "its origin must be shipped, a catalogue or the catalogue folder.";
}

function measurementProblem(value: unknown): string | null {
  if (!isObject(value)) return "a measurement must be an object.";
  const keys = ["rowCount", "geometryColumn", "geometryType", "crsAssumed"];
  if (Object.keys(value).some((k) => !keys.includes(k)) || keys.some((k) => !(k in value))) {
    return `a measurement holds exactly ${keys.join(", ")}.`;
  }
  if (!Number.isSafeInteger(value.rowCount) || (value.rowCount as number) < 0) return "a measurement's rowCount must be a count.";
  for (const key of ["geometryColumn", "geometryType"]) {
    if (value[key] !== null && typeof value[key] !== "string") return `a measurement's ${key} must be text or null.`;
  }
  if (typeof value.crsAssumed !== "boolean") return "a measurement's crsAssumed must be true or false.";
  return null;
}

/** The first problem with a record's shape, or null. */
export function recordProblem(value: unknown): string | null {
  if (!isObject(value)) return "The record must be a JSON object.";
  const keys = ["formatVersion", "id", "version", "archive", "origin", "files", "measured"];
  for (const key of Object.keys(value)) if (!keys.includes(key)) return `The record has a field the format does not name: "${key}".`;
  for (const key of keys) if (!(key in value)) return `The record has no "${key}".`;
  if (value.formatVersion !== RECORD_FORMAT_VERSION) return `The record is in format ${String(value.formatVersion)}; this server reads format ${RECORD_FORMAT_VERSION}.`;
  if (typeof value.id !== "string" || !isTemplateVersion(value.version)) return "The record must name its template and version.";
  const archive = value.archive;
  if (!isObject(archive) || typeof archive.sha256 !== "string" || !SHA256.test(archive.sha256) || !Number.isSafeInteger(archive.size) || (archive.size as number) < 0) {
    return "The record must give the archive's SHA-256 and size.";
  }
  const origin = originProblem(value.origin);
  if (origin) return `The record: ${origin}`;
  if (!isObject(value.files)) return "The record must list its files.";
  for (const [member, entry] of Object.entries(value.files)) {
    if (!isObject(entry) || !Number.isSafeInteger(entry.bytes) || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      return `The record's entry for "${member}" must give its size and SHA-256.`;
    }
  }
  if (!isObject(value.measured)) return "The record must give what was measured.";
  for (const [member, measurement] of Object.entries(value.measured)) {
    const problem = measurementProblem(measurement);
    if (problem) return `The record's measurement of "${member}": ${problem}`;
  }
  return null;
}

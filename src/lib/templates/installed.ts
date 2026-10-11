import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { admitTemplateFolder, type AdmittedTemplate } from "./admission";
import { TEMPLATE_DOCUMENT_MAX_BYTES } from "./format";
import { refuse, TemplateRefusal } from "./refusals";

/**
 * The installed form: a version unpacked into a folder of its own, with a
 * record beside its members.
 *
 * The record says what the folder is and where it came from: the archive's
 * checksum and size, its origin (shipped in the image, a catalogue by its
 * scheme and host, or the catalogue folder the deployment names, never by
 * its path), every member's size and checksum, and what the dataset reader
 * measured of each dataset and bundled result when the version was
 * admitted. A folder is read back only when every member still matches its
 * record and the documents still pass the first stage, so a version that
 * changed on disk after it was admitted is refused rather than trusted.
 */

export const RECORD_FILE = "record.json";
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

export interface InstalledVersion {
  folder: string;
  record: InstalledRecord;
  admitted: AdmittedTemplate;
}

const SHA256 = /^[0-9a-f]{64}$/;

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mismatch(message: string): never {
  return refuse("template_record_mismatch", message);
}

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
  if (typeof value.id !== "string" || !Number.isSafeInteger(value.version)) return "The record must name its template and version.";
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

/** Every member of a folder that the record lists, with its size and
 * checksum, from the admitted version's own member list. */
async function filesOf(admitted: AdmittedTemplate): Promise<InstalledRecord["files"]> {
  const files: InstalledRecord["files"] = {};
  for (const [member, bytes] of [...admitted.members].sort(([a], [b]) => a.localeCompare(b))) {
    if (member === RECORD_FILE) continue;
    files[member] = { bytes, sha256: await fileSha256(path.join(admitted.folder, member)) };
  }
  return files;
}

/** The members a record must measure: every dataset and bundled result. */
function measuredMembers(admitted: AdmittedTemplate): string[] {
  return [
    ...admitted.datasets.map((d) => d.file),
    ...(admitted.workflow?.steps ?? []).map((s) => s.result),
  ];
}

/**
 * Write the record of a folder whose documents passed the first stage, with
 * what was measured of its datasets; the folder becomes an installed
 * version. Answers the record written.
 */
export async function writeInstalledRecord(
  admitted: AdmittedTemplate,
  install: { archive: { sha256: string; size: number }; origin: InstalledOrigin; measured: Record<string, DatasetMeasurement> },
): Promise<InstalledRecord> {
  const expected = measuredMembers(admitted);
  const given = Object.keys(install.measured);
  if (expected.length !== given.length || expected.some((m) => !given.includes(m))) {
    throw new Error("A record measures every dataset and bundled result of the version, and nothing else.");
  }
  const record: InstalledRecord = {
    formatVersion: RECORD_FORMAT_VERSION,
    id: admitted.facts.id,
    version: admitted.facts.version,
    archive: install.archive,
    origin: install.origin,
    files: await filesOf(admitted),
    measured: Object.fromEntries(expected.map((m) => [m, install.measured[m]])),
  };
  const problem = recordProblem(record);
  if (problem) throw new Error(problem);
  await writeFile(path.join(admitted.folder, RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * Read an installed version back: its record, every member against it
 * (size and checksum, nothing missing, nothing added), and its documents
 * through the first stage again. A coded refusal names the first fault.
 */
export async function readInstalledVersion(folder: string): Promise<InstalledVersion> {
  let text: string;
  try {
    text = await readFile(path.join(folder, RECORD_FILE), "utf8");
  } catch {
    return mismatch("The installed version has no record.");
  }
  if (Buffer.byteLength(text) > TEMPLATE_DOCUMENT_MAX_BYTES) mismatch("The installed version's record is larger than a document may be.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return mismatch("The installed version's record is not JSON.");
  }
  const problem = recordProblem(raw);
  if (problem) mismatch(problem);
  const record = raw as InstalledRecord;
  const admitted = await admitTemplateFolder(folder, { extraMembers: [RECORD_FILE] });
  if (admitted.facts.id !== record.id || admitted.facts.version !== record.version) {
    mismatch(`The record is of ${record.id} version ${record.version}, and the folder holds ${admitted.facts.id} version ${admitted.facts.version}.`);
  }
  const listed = Object.keys(record.files);
  for (const member of admitted.members.keys()) {
    if (member !== RECORD_FILE && !listed.includes(member)) mismatch(`The installed version holds "${member}", which its record does not list.`);
  }
  for (const [member, entry] of Object.entries(record.files)) {
    const bytes = admitted.members.get(member);
    if (bytes === undefined) mismatch(`The record lists "${member}", which the installed version does not hold.`);
    if (bytes !== entry.bytes || (await fileSha256(path.join(folder, member))) !== entry.sha256) {
      mismatch(`The member "${member}" differs from its record.`);
    }
  }
  const expected = measuredMembers(admitted);
  const measured = Object.keys(record.measured);
  if (expected.length !== measured.length || expected.some((m) => !measured.includes(m))) {
    mismatch("The record must measure every dataset and bundled result, and nothing else.");
  }
  return { folder, record, admitted };
}

export { TemplateRefusal };

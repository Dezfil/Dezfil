import { currentTrustedOperation } from "@/lib/trusted-operation";
import { templateFileDigest } from "./files";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { admitTemplateFolder, type AdmittedTemplate } from "./admission";
import { TEMPLATE_DOCUMENT_MAX_BYTES } from "./format";
import {
  RECORD_FILE,
  RECORD_FORMAT_VERSION,
  recordProblem,
  type DatasetMeasurement,
  type InstalledOrigin,
  type InstalledRecord,
} from "./record";
import { preserveTemplateResourceRefusal, refuse, TemplateRefusal } from "./refusals";

export {
  downloadedTemplatesDir,
  RECORD_FILE,
  RECORD_FORMAT_VERSION,
  recordProblem,
  type DatasetMeasurement,
  type InstalledOrigin,
  type InstalledRecord,
} from "./record";

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

export interface InstalledVersion {
  folder: string;
  record: InstalledRecord;
  admitted: AdmittedTemplate;
}

export async function fileSha256(file: string): Promise<string> {
  return templateFileDigest(file);
}

function mismatch(message: string): never {
  return refuse("template_record_mismatch", message);
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
  currentTrustedOperation()?.assertCanCommit();
  await writeFile(path.join(admitted.folder, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", { signal: currentTrustedOperation()?.signal });
  return record;
}

/**
 * Read an installed version back: its record, every member against it
 * (size and checksum, nothing missing, nothing added), and its documents
 * through the first stage again. A coded refusal names the first fault.
 */
export async function readInstalledVersion(folder: string): Promise<InstalledVersion> {
  currentTrustedOperation()?.enterStage("installed template");
  let text: string;
  try {
    text = await readFile(path.join(folder, RECORD_FILE), { encoding: "utf8", signal: currentTrustedOperation()?.signal });
  } catch (error) {
    preserveTemplateResourceRefusal(error);
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

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TEMPLATE_DOCUMENT_MAX_BYTES } from "./format";
import { downloadedTemplatesDir, RECORD_FILE, recordProblem, type InstalledRecord } from "./record";
import { SHIPPED_INDEX_FILE, shippedIndexProblem, shippedTemplatesDir, type ShippedIndex } from "./shipped-index";

/**
 * The engine's copies of the installed templates' data.
 *
 * The engine that runs people's SQL reads only the data folder's artifact
 * directory, so each dataset and bundled result a template's map reads is
 * made present there under its content's name, `template-<sha256>.parquet`:
 * a hard link to a downloaded version's file, a copy of a shipped one (the
 * image is another disk). Those copies are kept for as long as an installed
 * version needs them, restarts included, so a shipped template's data is
 * copied once rather than at every start: the boot sweep keeps them,
 * Storage counts them as templates (a file with two names once), and
 * Remove all takes the ones only the versions it removes needed.
 *
 * Which copies are needed is read from the installed versions' records,
 * light: the shipped index with each listed version's record, and the
 * record of each downloaded version folder. A record that does not read
 * needs nothing. Light on purpose, with no admission and no engine, so the
 * boot sweep can ask.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

/** The artifact a template file of this content is made present as,
 * relative to the data folder. */
export function templateArtifactName(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error("A template artifact is named by its SHA-256.");
  return `tables/template-${sha256}.parquet`;
}

/** An installed version's folder, with what it is. */
export interface InstalledFolder {
  folder: string;
  id: string;
  version: number;
  shipped: boolean;
}

async function readSmallJson(file: string): Promise<unknown> {
  if ((await stat(file)).size > TEMPLATE_DOCUMENT_MAX_BYTES) throw new Error("larger than a document may be");
  return JSON.parse(await readFile(file, "utf8"));
}

/** A version folder's record, when it reads as this version's; else null. */
export async function recordAt(folder: string, id: string, version: number): Promise<InstalledRecord | null> {
  try {
    const raw = await readSmallJson(path.join(folder, RECORD_FILE));
    if (recordProblem(raw) !== null) return null;
    const record = raw as InstalledRecord;
    return record.id === id && record.version === version ? record : null;
  } catch {
    return null;
  }
}

/** The downloaded version folders, `templates/<id>/<version>/`, every
 * version of every id, read from the data folder. */
export async function downloadedFolders(): Promise<InstalledFolder[]> {
  const root = downloadedTemplatesDir();
  const out: InstalledFolder[] = [];
  const ids = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const id of ids.filter((entry) => entry.isDirectory() && ID.test(entry.name))) {
    const versions = await readdir(path.join(root, id.name), { withFileTypes: true }).catch(() => []);
    for (const version of versions.filter((entry) => entry.isDirectory() && VERSION.test(entry.name))) {
      out.push({ folder: path.join(root, id.name, version.name), id: id.name, version: Number(version.name), shipped: false });
    }
  }
  return out;
}

/** The shipped version folders the image's index lists. */
async function shippedFolders(): Promise<InstalledFolder[]> {
  const dir = shippedTemplatesDir();
  let index: unknown;
  try {
    index = await readSmallJson(path.join(dir, SHIPPED_INDEX_FILE));
  } catch {
    return [];
  }
  if (shippedIndexProblem(index) !== null) return [];
  return (index as ShippedIndex).templates.map((t) => ({ folder: path.join(dir, t.id, String(t.version)), id: t.id, version: t.version, shipped: true }));
}

/** The artifact file names, in the artifact directory, that a record's
 * datasets and bundled results are made present under. */
export function artifactsOf(record: InstalledRecord): string[] {
  return Object.keys(record.measured)
    .map((member) => record.files[member]?.sha256)
    .filter((sha256): sha256 is string => typeof sha256 === "string" && SHA256.test(sha256))
    .map((sha256) => path.basename(templateArtifactName(sha256)));
}

/** Every artifact file name an installed version needs now: the shipped
 * ones and the downloaded ones together. */
export async function templateArtifactsInUse(): Promise<Set<string>> {
  const needed = new Set<string>();
  for (const installed of [...(await shippedFolders()), ...(await downloadedFolders())]) {
    const record = await recordAt(installed.folder, installed.id, installed.version);
    if (record) for (const name of artifactsOf(record)) needed.add(name);
  }
  return needed;
}

/** Every file's bytes under `folder`, looked at with `lstat`: a link counts
 * nothing, and a file with two names inside it counts each. */
export async function bytesUnder(folder: string): Promise<number> {
  let total = 0;
  const pending = [folder];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(at);
      else if (entry.isFile()) total += (await lstat(at).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** What the downloaded templates hold: how many version folders, and the
 * bytes every file under the data folder's `templates/` takes, which is
 * what Remove all frees. */
export async function downloadedTotals(): Promise<{ versions: number; bytes: number }> {
  return { versions: (await downloadedFolders()).length, bytes: await bytesUnder(downloadedTemplatesDir()) };
}

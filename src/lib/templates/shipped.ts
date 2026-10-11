import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SHIPPED_TEMPLATES_MAX_BYTES, TEMPLATE_DOCUMENT_MAX_BYTES } from "./format";
import { readInstalledVersion, type InstalledVersion } from "./installed";
import { TemplateRefusal } from "./refusals";

/**
 * The shipped set: the templates the image carries, installed in the
 * repository's top-level `templates/` folder and copied into the image
 * beside the application. The folder holds an index and one installed
 * version folder per listed version, `<id>/<version>/`; the index lists
 * the versions the release ships, and nothing else is in the folder.
 *
 * The set changes only with a release, and the shipped versions work with
 * no network: their data, facts and pictures are all on disk.
 */

export const SHIPPED_INDEX_FILE = "index.json";
export const SHIPPED_INDEX_FORMAT_VERSION = 1;

export interface ShippedIndex {
  formatVersion: number;
  templates: { id: string; version: number }[];
}

/** The shipped folder: beside the application, in the image and in a
 * checkout alike. */
export function shippedTemplatesDir(): string {
  return path.join(process.cwd(), "templates");
}

export interface ShippedSetCheck {
  /** Every listed version that passed, in the index's order. */
  versions: InstalledVersion[];
  /** Every member of the listed versions together, records included. */
  bytes: number;
  /** One line per fault, naming the version and its refusal. */
  problems: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function indexProblem(value: unknown): string | null {
  if (!isObject(value)) return "The shipped index must be a JSON object.";
  if (Object.keys(value).some((k) => k !== "formatVersion" && k !== "templates")) return "The shipped index holds a field the format does not name.";
  if (value.formatVersion !== SHIPPED_INDEX_FORMAT_VERSION) return `The shipped index is in format ${String(value.formatVersion)}; this server reads format ${SHIPPED_INDEX_FORMAT_VERSION}.`;
  if (!Array.isArray(value.templates)) return "The shipped index must list its templates.";
  const seen = new Set<string>();
  for (const [i, entry] of value.templates.entries()) {
    if (!isObject(entry) || Object.keys(entry).length !== 2 || typeof entry.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(entry.id) || !Number.isSafeInteger(entry.version) || (entry.version as number) < 1) {
      return `The shipped index's templates[${i}] must be { id, version }.`;
    }
    if (seen.has(entry.id)) return `The shipped index lists "${entry.id}" twice.`;
    seen.add(entry.id);
  }
  return null;
}

/** Read the shipped index; a missing or malformed one is a fault of the
 * release, named. */
export async function readShippedIndex(dir: string): Promise<ShippedIndex> {
  const text = await readFile(path.join(dir, SHIPPED_INDEX_FILE), "utf8");
  if (Buffer.byteLength(text) > TEMPLATE_DOCUMENT_MAX_BYTES) throw new Error("The shipped index is larger than a document may be.");
  const raw: unknown = JSON.parse(text);
  const problem = indexProblem(raw);
  if (problem) throw new Error(problem);
  return raw as ShippedIndex;
}

/**
 * Hold a shipped folder to the rules every template must meet: the index
 * well formed, each listed version installed at `<id>/<version>/` and read
 * back whole against its record (the first stage, the licence and credit
 * rules among it), nothing in the folder the index does not list, and every
 * listed version together within the shipped bound. Answers every fault,
 * not only the first, so a release sees all it must fix.
 */
export async function checkShippedSet(
  dir: string = shippedTemplatesDir(),
  { maxBytes = SHIPPED_TEMPLATES_MAX_BYTES }: { maxBytes?: number } = {},
): Promise<ShippedSetCheck> {
  const problems: string[] = [];
  let index: ShippedIndex;
  try {
    index = await readShippedIndex(dir);
  } catch (error) {
    return { versions: [], bytes: 0, problems: [error instanceof Error ? error.message : String(error)] };
  }
  const versions: InstalledVersion[] = [];
  let bytes = 0;
  for (const entry of index.templates) {
    const label = `${entry.id} version ${entry.version}`;
    try {
      const version = await readInstalledVersion(path.join(dir, entry.id, String(entry.version)));
      if (version.record.origin.kind !== "shipped") problems.push(`${label}: its record does not say it is shipped.`);
      bytes += [...version.admitted.members.values()].reduce((sum, b) => sum + b, 0);
      versions.push(version);
    } catch (error) {
      if (error instanceof TemplateRefusal) problems.push(`${label}: ${error.code}: ${error.message}`);
      else problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const listed = new Map(index.templates.map((t) => [t.id, String(t.version)]));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === SHIPPED_INDEX_FILE) continue;
    if (!entry.isDirectory() || !listed.has(entry.name)) {
      problems.push(`The shipped folder holds "${entry.name}", which its index does not list.`);
      continue;
    }
    for (const version of await readdir(path.join(dir, entry.name))) {
      if (version !== listed.get(entry.name)) problems.push(`The shipped folder holds "${entry.name}/${version}", which its index does not list.`);
    }
  }
  if (bytes > maxBytes) {
    problems.push(`The shipped templates together are ${(bytes / (1024 * 1024)).toFixed(1)} MB; the image carries at most ${(maxBytes / (1024 * 1024)).toFixed(1)} MB of them.`);
  }
  return { versions, bytes, problems };
}

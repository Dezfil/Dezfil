import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { TEMPLATE_DOCUMENT_MAX_BYTES } from "./format";

/**
 * Where the shipped set lives and what its index says, read by the
 * shipped set's check (shipped.ts) and by the template documents' reader
 * (resident.ts) alike. Light on purpose: no admission, no engine.
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function shippedIndexProblem(value: unknown): string | null {
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

/** The shipped index read at once, for a reader that answers in the same
 * turn; null when it is missing or malformed, which leaves the shipped set
 * empty to that reader. */
export function readShippedIndexSync(dir: string = shippedTemplatesDir()): ShippedIndex | null {
  try {
    const file = path.join(dir, SHIPPED_INDEX_FILE);
    if (statSync(file).size > TEMPLATE_DOCUMENT_MAX_BYTES) return null;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return shippedIndexProblem(raw) === null ? (raw as ShippedIndex) : null;
  } catch {
    return null;
  }
}

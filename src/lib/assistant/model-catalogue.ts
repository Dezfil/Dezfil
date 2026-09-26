/** Server-only local file reader. Never import this module from a pane. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/config";
import type { CatalogueEntry, ModelCatalogue } from "./model-knowledge";

export const CATALOGUE_LIMIT = 256 * 1024;
export type CatalogueState =
  | { source: "shipped"; instance: "absent" }
  | { source: "merged"; instance: "applied" }
  | { source: "shipped"; instance: "rejected"; reason: string };
export type CatalogueSnapshot = { models: ModelCatalogue; catalogue: CatalogueState };

// Provider words from OpenAI's ReasoningEffort in
// node_modules/openai/resources/shared.d.ts and Anthropic's OutputConfig.effort
// in node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts.
const VOCABULARY = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (where: string, why: string): never => { throw new Error(`${where}: ${why}.`); };

/** Validate the entire file before merging any entry. Reasons name positions
 * and fields, never model identities, values or JSON parser excerpts. */
export function validateCatalogue(value: unknown, shipped = false): ModelCatalogue {
  if (!object(value)) return invalid("catalogue", "expected an object");
  if (Object.keys(value).some((key) => key !== "openai" && key !== "anthropic")) invalid("catalogue", "unknown provider or field");
  const result: ModelCatalogue = { openai: [], anthropic: [] };
  for (const provider of ["openai", "anthropic"] as const) {
    const entries = value[provider];
    if (entries === undefined && !shipped) continue;
    if (!Array.isArray(entries)) invalid(provider, "expected a model list");
    const seen = new Set<string>();
    for (const [index, entry] of (entries as unknown[]).entries()) {
      const where = `${provider}[${index}]`;
      if (!object(entry)) invalid(where, "expected a model object");
      const model = entry as Record<string, unknown>;
      if (Object.keys(model).some((key) => !["id", "name", "efforts"].includes(key))) invalid(where, "unknown field; allowed fields are id, name, efforts");
      for (const field of ["id", "name"] as const) {
        if (typeof model[field] !== "string" || !(model[field] as string).trim()) invalid(`${where}.${field}`, "expected a nonblank string");
      }
      const id = model.id as string;
      if (seen.has(id)) invalid(`${where}.id`, "duplicate identity");
      seen.add(id);
      if (!Array.isArray(model.efforts)) invalid(`${where}.efforts`, "expected a list");
      const efforts = model.efforts as unknown[];
      const levels = new Set<string>();
      for (const [level, effort] of efforts.entries()) {
        if (typeof effort !== "string" || !VOCABULARY[provider].includes(effort)) invalid(`${where}.efforts[${level}]`, "invalid effort word");
        if (levels.has(effort as string)) invalid(`${where}.efforts[${level}]`, "duplicate effort");
        levels.add(effort as string);
      }
      result[provider].push({ id, name: model.name as string, efforts: efforts as string[] });
    }
  }
  return result;
}

function readFile(file: string, shipped: boolean): ModelCatalogue {
  // O_NONBLOCK lets a misplaced FIFO fail the regular-file check without
  // waiting for a writer. Size is checked again after the bounded read.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) invalid("catalogue", "expected a regular file");
    if (stat.size > CATALOGUE_LIMIT) invalid("catalogue", "file exceeds 256 KiB");
    const bytes = Buffer.alloc(CATALOGUE_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > CATALOGUE_LIMIT) invalid("catalogue", "file exceeds 256 KiB");
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { return invalid("catalogue", "invalid JSON"); }
    return validateCatalogue(value, shipped);
  } finally { closeSync(fd); }
}

function merge(base: CatalogueEntry[], additions: CatalogueEntry[]): CatalogueEntry[] {
  const replacements = new Map(additions.map((entry) => [entry.id, entry]));
  const ids = new Set(base.map((entry) => entry.id));
  return [...base.map((entry) => replacements.get(entry.id) ?? entry), ...additions.filter((entry) => !ids.has(entry.id))];
}

/** A request-local snapshot, with no last-good cache or provider input. */
export function readModelCatalogue(): CatalogueSnapshot {
  const models = readFile(path.join(process.cwd(), "src/lib/assistant/model-catalogue.json"), true);
  let instance: ModelCatalogue;
  try { instance = readFile(path.join(dataDir(), "assistant-models.json"), false); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { models, catalogue: { source: "shipped", instance: "absent" } };
    const reason = code ? `Instance catalogue could not be read (${code}).` : (error as Error).message;
    return { models, catalogue: { source: "shipped", instance: "rejected", reason } };
  }
  return {
    models: { openai: merge(models.openai, instance.openai), anthropic: merge(models.anthropic, instance.anthropic) },
    catalogue: { source: "merged", instance: "applied" },
  };
}

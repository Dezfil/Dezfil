/**
 * The template format: what a version of a template is, as data.
 *
 * A version is a project export (its manifest, its map and workflow
 * documents, its datasets) extended beside the manifest by a facts
 * document, a folder of bundled results (one dataset per workflow step,
 * named by the step) and a folder of map pictures (one PNG per theme). The
 * archive is the transport form; installed, the same members sit unpacked
 * in a version folder.
 *
 * Dependency-free on purpose: the screens read the facts' shape and the
 * closed lists from here, and nothing in it reaches the server. It reads
 * only the ids module, which is free of any, for the one rule of a version
 * number every reader shares.
 */

import { isTemplateVersion } from "./ids";

/** The template format's own version, beside the export's. A version this
 * server does not read is refused, never guessed at. */
export const TEMPLATE_FORMAT_VERSION = 1;

/** The members every version holds at its root. */
export const MANIFEST_FILE = "project.json";
export const FACTS_FILE = "template.json";
export const RESULTS_FOLDER = "results";
export const PICTURES_FOLDER = "pictures";

/** The tags a template may carry: a closed list, one to three of them. */
export const TEMPLATE_TAGS = [
  "First map",
  "Time",
  "Analysis",
  "3D",
  "Big data",
  "Widgets",
  "Flows",
] as const;
export type TemplateTag = (typeof TEMPLATE_TAGS)[number];

export const TEMPLATE_KINDS = ["map", "workflow"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** One map picture per theme, as the card images are kept. */
export const TEMPLATE_THEMES = ["light", "dark"] as const;
export type TemplateTheme = (typeof TEMPLATE_THEMES)[number];

const MB = 1024 * 1024;
/** An archive as transferred. */
export const TEMPLATE_ARCHIVE_MAX_BYTES = 150 * MB;
/** One map picture. */
export const TEMPLATE_PICTURE_MAX_BYTES = 2 * MB;
/** The catalogue's index. */
export const TEMPLATE_INDEX_MAX_BYTES = 1 * MB;
/** Every shipped version together, unpacked. */
export const SHIPPED_TEMPLATES_MAX_BYTES = 50 * MB;
/** One JSON document of a version: far above any real map or workflow, so
 * a document is never read whole into memory past it. */
export const TEMPLATE_DOCUMENT_MAX_BYTES = 8 * MB;
/** Steps in a workflow example. */
export const TEMPLATE_STEPS_MAX = 50;

export interface TemplateSource {
  /** Who published the data, as the credit names them. */
  name: string;
  /** The licence's identifier: SPDX's where it lists the terms, else a
   * `LicenseRef-` name the template rules admit. */
  licence: string;
  /** The credit text the source asks for, word for word. */
  credit: string;
}

/** One step of a workflow example as its card draws the graph: the
 * workflow document's own, in its order. */
export interface TemplateStep {
  /** The step's id in the workflow document. */
  id: string;
  /** The operation it runs, by its id in the operation catalogue. */
  operation: string;
  /** The name of the dataset it makes, as one is stored. */
  output: string;
  /** The names it reads, as a run reads them: datasets of the template and
   * earlier steps' outputs. */
  reads: string[];
}

export interface TemplateDatasetLine {
  /** A dataset of the version, by its name in the manifest. */
  dataset: string;
  /** The source it came from, by its name in `sources`. */
  source: string;
  /** How it was made, in one line. */
  made: string;
}

export interface TemplateFacts {
  formatVersion: number;
  /** Stable across versions: lowercase letters, digits and hyphens. */
  id: string;
  /** Immutable once listed; a newer version has a greater number. */
  version: number;
  kind: TemplateKind;
  title: string;
  question: string;
  place: string;
  tags: TemplateTag[];
  /** The data's date: a year, a month or a day. */
  dataDate: string;
  sources: TemplateSource[];
  howMade: {
    /** The question in full. */
    question: string;
    datasets: TemplateDatasetLine[];
    /** The styling choices, one line each. */
    styling: string[];
  };
  /** A workflow example's steps in their order; a map template has none. */
  steps?: TemplateStep[];
  /** The picture file per theme, under the pictures folder. */
  pictures: Record<TemplateTheme, string>;
}

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** An id the copy rebinds and a file may be named by: no separator, no
 * dot, nothing a path could be built from. A step's and a layer's. */
export const TEMPLATE_PART_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A dataset's or an output's name as one is stored. */
const STORED_NAME = /^[a-z][a-z0-9_]{0,127}$/;
/** An operation's id in the operation catalogue. */
const OPERATION = /^[a-z][a-z0-9_]{0,63}$/;
/** Words the API's template paths take beside an id. */
export const RESERVED_IDS = ["refresh", "downloads"] as const;
const DATA_DATE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;
const LICENCE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const PICTURE = /^pictures\/[a-z0-9-]{1,40}\.png$/;
/** Characters a line of plain text never carries. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

type Problem = string | null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Refuse keys the shape does not name: the facts are a closed shape. */
function closed(value: Record<string, unknown>, keys: readonly string[], at: string): Problem {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return `${at} has a field the format does not name: "${key}".`;
  }
  return null;
}

function text(value: unknown, at: string, max: number, multiline = false): Problem {
  if (typeof value !== "string" || value.trim() === "") return `${at} must be non-blank text.`;
  if ([...value].length > max) return `${at} is longer than ${max} characters.`;
  if (CONTROL.test(value) || (!multiline && /[\r\n\t]/.test(value))) {
    return `${at} holds a control character.`;
  }
  return null;
}

function list(value: unknown, at: string, min: number, max: number): Problem {
  if (!Array.isArray(value)) return `${at} must be a list.`;
  if (value.length < min || value.length > max) {
    return min === max
      ? `${at} must hold exactly ${min}.`
      : `${at} must hold ${min} to ${max} entries.`;
  }
  return null;
}

function source(value: unknown, at: string): Problem {
  if (!isObject(value)) return `${at} must be an object.`;
  return (
    closed(value, ["name", "licence", "credit"], at) ??
    text(value.name, `${at}.name`, 120) ??
    (typeof value.licence === "string" && LICENCE.test(value.licence)
      ? null
      : `${at}.licence must be a licence identifier such as CC-BY-4.0.`) ??
    text(value.credit, `${at}.credit`, 300)
  );
}

function datasetLine(value: unknown, at: string): Problem {
  if (!isObject(value)) return `${at} must be an object.`;
  return (
    closed(value, ["dataset", "source", "made"], at) ??
    text(value.dataset, `${at}.dataset`, 120) ??
    text(value.source, `${at}.source`, 120) ??
    text(value.made, `${at}.made`, 300)
  );
}

/**
 * A workflow example's step list: each step once, its output a name no
 * dataset or earlier step has, reading only the template's datasets (the
 * ones a line of how it is made names) and earlier steps' outputs, so the
 * graph a card draws from it has no source outside the template. A map
 * template lists none. Whether the list is the workflow's own is the
 * admission's to hold, against the workflow document.
 */
function stepsProblem(value: Record<string, unknown>, datasets: ReadonlySet<string>): Problem {
  if (value.kind !== "workflow") return "steps" in value ? "A map template's facts list no steps." : null;
  if (!("steps" in value)) return "A workflow example's facts must list its steps.";
  const steps = list(value.steps, "steps", 1, TEMPLATE_STEPS_MAX);
  if (steps) return steps;
  const keys = ["id", "operation", "output", "reads"] as const;
  const ids = new Set<string>();
  const outputs = new Set<string>();
  for (const [i, raw] of (value.steps as unknown[]).entries()) {
    const at = `steps[${i}]`;
    if (!isObject(raw)) return `${at} must be an object.`;
    const shape = closed(raw, keys, at);
    if (shape) return shape;
    for (const key of keys) {
      if (!(key in raw)) return `${at} has no "${key}".`;
    }
    if (typeof raw.id !== "string" || !TEMPLATE_PART_ID.test(raw.id)) {
      return `${at}.id must be letters, digits, hyphens and underscores, at most 64 characters.`;
    }
    if (ids.has(raw.id)) return `steps names the step "${raw.id}" twice.`;
    if (typeof raw.operation !== "string" || !OPERATION.test(raw.operation)) {
      return `${at}.operation must be an operation's id.`;
    }
    if (typeof raw.output !== "string" || !STORED_NAME.test(raw.output)) {
      return `${at}.output must be a dataset name as one is stored.`;
    }
    if (datasets.has(raw.output) || outputs.has(raw.output)) {
      return `${at}.output names "${raw.output}", which a dataset or an earlier step already has.`;
    }
    const reads = list(raw.reads, `${at}.reads`, 0, 2 * TEMPLATE_STEPS_MAX);
    if (reads) return reads;
    for (const read of raw.reads as unknown[]) {
      if (typeof read !== "string" || !STORED_NAME.test(read)) return `${at}.reads must list names as they are stored.`;
      if (!datasets.has(read) && !outputs.has(read)) {
        return `${at}.reads names "${read}", which is neither a dataset of the template nor an earlier step's output.`;
      }
    }
    if (new Set(raw.reads as string[]).size !== (raw.reads as string[]).length) return `${at}.reads names one dataset twice.`;
    ids.add(raw.id);
    outputs.add(raw.output);
  }
  return null;
}

/**
 * The first problem with a facts document, or null when it has the
 * format's shape. Closed throughout: a field the format does not name is a
 * problem, so nothing rides along unread. The format version is the
 * caller's to check first: a version this server does not read is a
 * refusal of its own, before its shape is judged.
 */
export function factsProblem(value: unknown): Problem {
  if (!isObject(value)) return "The facts must be a JSON object.";
  const keys = [
    "formatVersion", "id", "version", "kind", "title", "question", "place",
    "tags", "dataDate", "sources", "howMade", "pictures",
  ] as const;
  const shape = closed(value, [...keys, "steps"], "The facts");
  if (shape) return shape;
  for (const key of keys) {
    if (!(key in value)) return `The facts have no "${key}".`;
  }
  if (typeof value.id !== "string" || !ID.test(value.id)) {
    return "id must be lowercase letters, digits and single hyphens, at most 64 characters.";
  }
  if ((RESERVED_IDS as readonly string[]).includes(value.id)) {
    return `id may not be ${RESERVED_IDS.join(" or ")}: the API's paths take those words.`;
  }
  if (!isTemplateVersion(value.version)) {
    return "version must be a whole number from 1.";
  }
  if (!(TEMPLATE_KINDS as readonly unknown[]).includes(value.kind)) {
    return `kind must be one of ${TEMPLATE_KINDS.join(", ")}.`;
  }
  const words =
    text(value.title, "title", 80) ??
    text(value.question, "question", 200) ??
    text(value.place, "place", 80);
  if (words) return words;
  const tags = list(value.tags, "tags", 1, 3);
  if (tags) return tags;
  const tagList = value.tags as unknown[];
  for (const tag of tagList) {
    if (!(TEMPLATE_TAGS as readonly unknown[]).includes(tag)) {
      return `tags may only be ${TEMPLATE_TAGS.join(", ")}.`;
    }
  }
  if (new Set(tagList).size !== tagList.length) return "tags names a tag twice.";
  if (typeof value.dataDate !== "string" || !DATA_DATE.test(value.dataDate)) {
    return "dataDate must be a year, a month or a day: 2024, 2024-05 or 2024-05-31.";
  }
  const sources = list(value.sources, "sources", 1, 12);
  if (sources) return sources;
  const sourceList = value.sources as unknown[];
  for (const [i, s] of sourceList.entries()) {
    const problem = source(s, `sources[${i}]`);
    if (problem) return problem;
  }
  const sourceNames = sourceList.map((s) => (s as TemplateSource).name);
  if (new Set(sourceNames).size !== sourceNames.length) return "sources names a source twice.";
  const howMade = value.howMade;
  if (!isObject(howMade)) return "howMade must be an object.";
  const made =
    closed(howMade, ["question", "datasets", "styling"], "howMade") ??
    text(howMade.question, "howMade.question", 2000, true) ??
    list(howMade.datasets, "howMade.datasets", 1, 50) ??
    list(howMade.styling, "howMade.styling", 1, 12);
  if (made) return made;
  for (const [i, line] of (howMade.datasets as unknown[]).entries()) {
    const problem = datasetLine(line, `howMade.datasets[${i}]`);
    if (problem) return problem;
    if (!sourceNames.includes((line as TemplateDatasetLine).source)) {
      return `howMade.datasets[${i}].source names no source of the template.`;
    }
  }
  for (const [i, line] of (howMade.styling as unknown[]).entries()) {
    const problem = text(line, `howMade.styling[${i}]`, 300);
    if (problem) return problem;
  }
  const steps = stepsProblem(value, new Set((howMade.datasets as TemplateDatasetLine[]).map((line) => line.dataset)));
  if (steps) return steps;
  const pictures = value.pictures;
  if (!isObject(pictures)) return "pictures must name a file per theme.";
  const pictureShape = closed(pictures, TEMPLATE_THEMES, "pictures");
  if (pictureShape) return pictureShape;
  for (const theme of TEMPLATE_THEMES) {
    const file = pictures[theme];
    if (typeof file !== "string" || !PICTURE.test(file)) {
      return `pictures.${theme} must name a PNG file under pictures/.`;
    }
  }
  if (pictures.light === pictures.dark) return "pictures names one file for both themes.";
  return null;
}

/** The catalogue's index: one entry per template, naming its newest
 * listed version, read at the catalogue address. */
export const CATALOGUE_INDEX_FILE = "index.json";
export const CATALOGUE_FORMAT_VERSION = 1;

export interface CatalogueEntry {
  /** The version's facts; its id and version are the entry's. */
  facts: TemplateFacts;
  /** The archive's size as transferred, in bytes. */
  size: number;
  /** The archive's SHA-256, hexadecimal. */
  sha256: string;
  /** The archive's address: relative to the index, or absolute under the
   * catalogue's origin. */
  archive: string;
  /** Each map picture's address, on the same terms. */
  pictures: Record<TemplateTheme, string>;
}

export interface CatalogueIndex {
  formatVersion: number;
  templates: CatalogueEntry[];
}

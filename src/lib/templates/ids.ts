/**
 * The ids a template's documents and datasets are addressed by.
 *
 * A template's map, workflow, layers, datasets and bundled results are
 * never rows in the store, so they have ids of a form of their own: the
 * template's id and version, the kind of document, and the document's own
 * id within the version where it has one. This module alone mints and reads
 * them. A stored row's id is a UUID, which never takes this form, so a
 * template id never reaches a store query as a row id, and a row id is never
 * read as a template's.
 *
 * Every part is made of letters, digits, hyphens and underscores (a
 * template id, a version number, a layer or step id, a dataset name), so the
 * dot that joins them is never inside one and an id reads back whole.
 *
 * Dependency-free on purpose, so any module may read it, a screen's
 * included.
 */

const PREFIX = "template";
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const PART = /^[A-Za-z0-9_-]{1,255}$/;

export type TemplateDocumentKind = "map" | "workflow" | "layer" | "dataset" | "result";

export interface TemplateDocumentRef {
  /** The template's id, the same across its versions. */
  template: string;
  version: number;
  kind: TemplateDocumentKind;
  /** The layer's id within the map, the dataset's name, or the step's id
   * whose bundled result it is; absent for the map and the workflow. */
  part?: string;
}

/** Mint the id of a template's document or dataset. */
export function templateDocumentId(ref: TemplateDocumentRef): string {
  if (!TEMPLATE_ID.test(ref.template) || !Number.isSafeInteger(ref.version) || ref.version < 1) {
    throw new Error("A template document id needs the template's id and a version from 1.");
  }
  const whole = ref.kind === "map" || ref.kind === "workflow";
  if (whole !== (ref.part === undefined) || (ref.part !== undefined && !PART.test(ref.part))) {
    throw new Error(`A template's ${ref.kind} id ${whole ? "has no part" : "names its part in letters, digits, hyphens and underscores"}.`);
  }
  return [PREFIX, ref.template, String(ref.version), ref.kind, ...(ref.part === undefined ? [] : [ref.part])].join(".");
}

/** Read an id back as a template's document, or null for any other id. */
export function parseTemplateDocumentId(id: string): TemplateDocumentRef | null {
  if (typeof id !== "string" || !id.startsWith(`${PREFIX}.`)) return null;
  const parts = id.split(".");
  const [prefix, template, version, kind, part, ...rest] = parts;
  if (prefix !== PREFIX || rest.length > 0 || !TEMPLATE_ID.test(template ?? "") || !VERSION.test(version ?? "")) return null;
  if (kind === "map" || kind === "workflow") {
    return part === undefined ? { template, version: Number(version), kind } : null;
  }
  if (kind === "layer" || kind === "dataset" || kind === "result") {
    return part !== undefined && PART.test(part) ? { template, version: Number(version), kind, part } : null;
  }
  return null;
}

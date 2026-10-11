import type { TemplateHome } from "@/lib/query/context";
import { parseTemplateDocumentId, type TemplateDocumentRef } from "./ids";

/**
 * Where the reach kernel and the evaluation context ask after a template's
 * map: whether an installed version answers to a map or layer id, and the
 * home that map's SQL binds in.
 *
 * The answers come from the template documents' reader (resident.ts),
 * which reads installed folders and so depends, through the template
 * format, on modules that depend on the kernel and the context in turn. It
 * provides itself here when it is first loaded, and the modules that
 * answer a template's map, its layers and its tiles load it before any
 * road can hand either one a template's id. Until it has, nothing answers:
 * a template's id is then refused as a missing one, never read as a row.
 */

export interface TemplateDocuments {
  /** Whether an installed version holds this map, or this layer in its map. */
  present(ref: TemplateDocumentRef): boolean;
  /** The home of the template whose map this is; null when none answers. */
  home(ref: TemplateDocumentRef): TemplateHome | null;
}

let provided: TemplateDocuments | null = null;

export function provideTemplateDocuments(documents: TemplateDocuments): void {
  provided = documents;
}

/** A template's map or layer id, read; null for any other id. */
export function templateMapPart(id: string): TemplateDocumentRef | null {
  const ref = parseTemplateDocumentId(id);
  return ref && (ref.kind === "map" || ref.kind === "layer") ? ref : null;
}

/** Whether an installed version answers to this template map or layer id. */
export function templatePresent(ref: TemplateDocumentRef): boolean {
  return provided?.present(ref) ?? false;
}

/** The home of the template map this id names, or null. */
export function templateHomeOf(ref: TemplateDocumentRef): TemplateHome | null {
  return provided?.home(ref) ?? null;
}

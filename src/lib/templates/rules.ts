import type { MapWidget } from "@/lib/widgets";
import type { TemplateFacts } from "./format";

/**
 * The rules a template's declared metadata must meet beside its documents'
 * shape: every source under a licence that allows redistribution, and the
 * map's credit note naming every source with its licence and credit text.
 *
 * The licence rule reads what the facts declare and nothing more: whether
 * the data really is under that licence is the curator's to establish. A
 * licence is admitted only from this list, each one allowing the data to
 * be redistributed and adapted with no non-commercial and no
 * no-redistribution clause; anything else (a non-commercial or
 * no-derivatives licence, a proprietary one, a name this list does not
 * hold) is refused. A new source under a licence missing here joins the
 * list by a change that says why it qualifies.
 *
 * Each name is SPDX's identifier where SPDX lists the terms. Open terms it
 * does not list (a city's open-data law, a national port of a Creative
 * Commons licence) take a `LicenseRef-` name, as SPDX writes a licence of
 * its own, with the terms and their address beside it.
 */
export const REDISTRIBUTABLE_LICENCES: readonly string[] = [
  "CC0-1.0",
  "CC-PDDC",
  "PDDL-1.0",
  "CC-BY-2.0",
  "CC-BY-2.5",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC-BY-SA-2.0",
  "CC-BY-SA-2.5",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
  "ODC-By-1.0",
  "ODbL-1.0",
  "OGL-UK-2.0",
  "OGL-UK-3.0",
  "OGL-Canada-2.0",
  "DL-DE-BY-2.0",
  "DL-DE-ZERO-2.0",
  "etalab-2.0",
  "NLOD-2.0",
  "CDLA-Permissive-1.0",
  "CDLA-Permissive-2.0",
  "CDLA-Sharing-1.0",
  // The Public Domain Mark, for works free of known copyright such as old maps: https://creativecommons.org/publicdomain/mark/1.0/
  "CC-PDM-1.0",
  // New York City's open-data law, Administrative Code § 23-502(d), no licence or restriction on use; the code's text at https://nyc-laws.readthedocs.io/en/latest/nycadmincode/t23/c05/
  "LicenseRef-NYC-Open-Data-Law",
  // Creative Commons Attribution 2.5 Argentina, a port SPDX does not list: https://creativecommons.org/licenses/by/2.5/ar/
  "LicenseRef-CC-BY-2.5-AR",
];

/** The first source whose licence the list does not admit, worded for the
 * refusal, or null. */
export function licenceProblem(facts: TemplateFacts): string | null {
  for (const source of facts.sources) {
    if (!REDISTRIBUTABLE_LICENCES.includes(source.licence)) {
      return `The source "${source.name}" is under ${source.licence}, which is not a licence that allows the data to be redistributed.`;
    }
  }
  return null;
}

/**
 * The first source the map's credit note does not name, worded for the
 * refusal, or null. The note is one visible note widget of the map whose
 * text names every source, its licence and its credit text, word for word:
 * the credit travels with the map wherever its widgets are drawn.
 */
export function creditProblem(facts: TemplateFacts, widgets: readonly MapWidget[]): string | null {
  const notes = widgets.filter((w) => w.type === "note" && w.visible && typeof w.note === "string");
  const credits = (note: string) =>
    facts.sources.every((s) => note.includes(s.name) && note.includes(s.licence) && note.includes(s.credit));
  if (notes.some((w) => credits(w.note!))) return null;
  if (notes.length === 0) return "The map has no visible note widget crediting its sources.";
  const missing = facts.sources.find((s) => !notes.some((w) => w.note!.includes(s.name) && w.note!.includes(s.licence) && w.note!.includes(s.credit)));
  return missing
    ? `The map's credit note does not name the source "${missing.name}" with its licence and credit text.`
    : "No one note of the map names every source with its licence and credit text.";
}

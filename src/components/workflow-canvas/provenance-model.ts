import type { DataTable } from "../api";
import { templateSentence } from "../template-sentence";

/**
 * The Provenance tab's words, composed from the dataset's record as the
 * inspection answers it and never recomputed: a derived table's
 * producing line with each input's resolution and the recorded
 * assumption, then the SQL that ran or the provider disclosure field by
 * field; an imported table's provenance in the record's terms only, with
 * the last-produced time exactly when the record carries one. The one
 * fact not the record's is the operation's label, which is the
 * catalogue's for the recorded identifier, or the identifier itself.
 */

export interface RecordedInput {
  name: string;
  currentName?: string;
  missing: boolean;
  nameReclaimed?: boolean;
}

export interface InputLine {
  name: string;
  /** What the read resolved, beside the recorded name; null when the id still carries it. */
  resolution: string | null;
}

export interface DisclosureField {
  label: string;
  value: string;
}

export type ProvenanceBody = { kind: "sql"; sql: string } | { kind: "disclosure"; endpoint: string | null; fields: DisclosureField[] };

export type Provenance =
  | { kind: "derived"; operation: string; ranAt: string | null; inputs: InputLine[]; assumed: boolean; body: ProvenanceBody }
  | { kind: "imported"; sentence: string; producedAt: string | null; assumed: boolean };

export const ASSUMED = "Coordinates assumed WGS84: an input had no declared coordinate system.";
export const NO_SQL_PROVIDER = "No SQL is recorded for a provider node.";
export const NO_ENDPOINT = "The endpoint is not recorded.";

export function inputLine(input: RecordedInput): InputLine {
  if (input.missing) {
    return { name: input.name, resolution: input.nameReclaimed ? "deleted, another table has its name now" : "deleted" };
  }
  if (input.currentName && input.currentName !== input.name) return { name: input.name, resolution: `now ${input.currentName}` };
  return { name: input.name, resolution: null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The endpoint as recorded, host and path; anything after a question mark is never shown. */
function endpointOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const q = s.indexOf("?");
  return q === -1 ? s : s.slice(0, q);
}

function words(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function valueOf(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (Array.isArray(v)) return v.length ? v.map(valueOf).join(", ") : "none";
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${words(k)} ${valueOf(x)}`)
      .join(", ");
  }
  return String(v);
}

/** Every field the record discloses, as recorded, the endpoint set apart. */
export function disclosureFields(disclosure: Record<string, unknown>): { endpoint: string | null; fields: DisclosureField[] } {
  const fields: DisclosureField[] = [];
  for (const [key, value] of Object.entries(disclosure)) {
    if (key === "endpoint") continue;
    fields.push({ label: words(key), value: valueOf(value) });
  }
  return { endpoint: endpointOf(disclosure.endpoint), fields };
}

/** The imported kinds' provenance sentences, in the record's terms only. */
export function importedSentence(table: Pick<DataTable, "source" | "sourceFilename" | "sourceParams">): string {
  const p = table.sourceParams ?? {};
  switch (table.source) {
    case "url":
      return `Imported from ${str(p.url) ?? "a URL"}`;
    case "overture":
      return `Overture ${str(p.theme) ?? "data"} · release ${str(p.release) ?? "unknown"}`;
    case "osm": {
      const selectors = Array.isArray(p.selectors) ? p.selectors.map(String).filter(Boolean) : [];
      return selectors.length ? `Overpass query: ${selectors.join(", ")}` : "Custom Overpass query";
    }
    case "postgis":
      return `Snapshot of ${str(p.schema) ?? "?"}.${str(p.table) ?? "?"} from ${str(p.connectionName) ?? "a connection"}`;
    case "sketch":
      return `Drawn on ${str(p.mapName) ?? "a map"}`;
    case "template":
      return templateSentence(p);
    default:
      return `Uploaded as ${table.sourceFilename ?? "a file"}`;
  }
}

export function provenanceOf(
  table: Pick<DataTable, "source" | "sourceFilename" | "sourceParams" | "importedAt" | "crsAssumed">,
  inputs: RecordedInput[] | null,
  labelOf: (operationId: string) => string | null,
): Provenance {
  if (table.source === "operation") {
    const p = table.sourceParams ?? {};
    const id = str(p.operation) ?? "an operation";
    const disclosure = p.disclosure && typeof p.disclosure === "object" ? (p.disclosure as Record<string, unknown>) : null;
    const body: ProvenanceBody = disclosure ? { kind: "disclosure", ...disclosureFields(disclosure) } : { kind: "sql", sql: str(p.sql) ?? "" };
    return {
      kind: "derived",
      operation: labelOf(id) ?? id,
      ranAt: str(p.ranAt) ?? table.importedAt,
      inputs: (inputs ?? []).map(inputLine),
      assumed: table.crsAssumed,
      body,
    };
  }
  return { kind: "imported", sentence: importedSentence(table), producedAt: table.importedAt, assumed: table.crsAssumed };
}

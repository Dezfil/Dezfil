import type { TableListing } from "../api";
import { listedFor, type CanvasMember, type NodeMember } from "./graph";

/**
 * What the results band shows for the selection, derived from the canvas
 * member, the tables listing as last read and the run overlay the member
 * wears. Pure: the state table, the tabs' availability and fallback, the
 * notes and the actions are decided here and unit-tested against fixtures;
 * the band only renders them.
 *
 * A node's dataset is its output **by id** in the listing: a node whose
 * output the listing no longer holds has none, and a table registered
 * under the declared name since is not it. A source is the table under its
 * name, whichever way it came to the canvas.
 */

export type BandTab = "messages" | "data" | "map" | "provenance";

export type Shown =
  | { kind: "nothing" }
  | { kind: "unproduced" }
  | { kind: "deleted" }
  | { kind: "missing" }
  | { kind: "dataset"; table: TableListing };

/** The Data tab's sentence for a selection without a dataset. */
export const STATUS: Record<Exclude<Shown["kind"], "dataset">, { big: string; small: string | null }> = {
  nothing: { big: "Select a node or a table to see its data", small: null },
  unproduced: { big: "No output yet", small: "Run the node to see its rows here." },
  deleted: { big: "This dataset no longer exists.", small: null },
  missing: { big: "This table no longer exists.", small: null },
};

export const SELECT_LEAD = "Select a node or a table to see its data";
export const NO_GEOMETRY_MAP = "No geometry in this dataset, so there is nothing to map.";
export const NO_GEOMETRY_LAYER = "No geometry: a table, not a layer.";

export function resolveShown(member: CanvasMember | null, tables: TableListing[]): Shown {
  if (!member) return { kind: "nothing" };
  if (member.kind === "node") {
    const output = member.step.output;
    if (!output) return { kind: "unproduced" };
    const table = tables.find((t) => t.id === output.id);
    return table ? { kind: "dataset", table } : { kind: "deleted" };
  }
  // The listing as last read decides, before the graph's own flag: a table
  // imported since the graph was built is present the moment the listing
  // says so. The dataset the graph resolved is the one meant; a name only
  // when the graph found none, and then its owner as the graph read it.
  const table = member.tableId !== null
    ? tables.find((t) => t.id === member.tableId)
    : listedFor(tables, member.name, member.space);
  return table ? { kind: "dataset", table } : { kind: "missing" };
}

/** Why each result tab is unavailable, or null when it can be chosen. */
export interface Availability {
  data: string | null;
  map: string | null;
  provenance: string | null;
}

export function availability(shown: Shown): Availability {
  switch (shown.kind) {
    case "nothing":
      return { data: SELECT_LEAD, map: SELECT_LEAD, provenance: SELECT_LEAD };
    case "unproduced":
      return { data: null, map: "Nothing has run yet", provenance: "Nothing has run yet" };
    case "deleted":
      return { data: null, map: "The dataset is gone", provenance: "The dataset is gone" };
    case "missing":
      return { data: null, map: "The table is gone", provenance: "The table is gone" };
    case "dataset":
      return { data: null, map: shown.table.geometryColumn === null ? NO_GEOMETRY_MAP : null, provenance: null };
  }
}

/** The tab to show for the one wanted: a tab unavailable for the selection
 * falls to Data, and with no selection to Messages. */
export function effectiveTab(wanted: BandTab, a: Availability): BandTab {
  if (wanted === "messages") return "messages";
  if (a[wanted] === null) return wanted;
  return a.data === null ? "data" : "messages";
}

export const NOTES = {
  inFlight: "A run is in flight. This is the output as it stands.",
  failed: "The latest run failed. This is the previous output, still in the workspace.",
  cancelled: "The latest run was cancelled. This is the previous output, still in the workspace.",
  stale: "An input changed since this ran. Run again to refresh it.",
  edited: "This output was built with the last successful run's parameters, not the pending edit.",
} as const;

/** Every fact that holds of a node's shown dataset, together:
 * the member's own wait in the run in flight, the latest attempt's failure
 * or cancellation, staleness, the pending edit. Nothing for a source. */
export function notesFor(member: CanvasMember | null, shown: Shown): string[] {
  if (!member || member.kind !== "node" || shown.kind !== "dataset") return [];
  const out: string[] = [];
  const word = member.run?.word;
  if (word === "waiting" || word === "queued" || word === "running") out.push(NOTES.inFlight);
  const attempt = member.step.latestAttempt?.state;
  if (attempt === "failed") out.push(NOTES.failed);
  if (attempt === "cancelled") out.push(NOTES.cancelled);
  if (member.step.conditions.includes("stale")) out.push(NOTES.stale);
  if (member.step.proposedParameters) out.push(NOTES.edited);
  return out;
}

export type AddToMap = { kind: "absent" } | { kind: "unavailable"; reason: string } | { kind: "available"; name: string };

/** *Add to a map* for the shown dataset: available for a
 * spatial one, unavailable with the reason for a table, absent otherwise. */
export function addToMapFor(shown: Shown): AddToMap {
  if (shown.kind !== "dataset") return { kind: "absent" };
  if (shown.table.geometryColumn === null) return { kind: "unavailable", reason: NO_GEOMETRY_LAYER };
  return { kind: "available", name: shown.table.qualifiedName ?? shown.table.name };
}

/** The bar's lead: a node by its label with its dataset's name, a source by
 * its name with the table mark. */
export function leadFor(member: CanvasMember | null): { kind: "node"; label: string; dataset: string | null } | { kind: "source"; name: string } | null {
  if (!member) return null;
  if (member.kind === "node") return { kind: "node", label: member.label, dataset: member.outputName || null };
  return { kind: "source", name: member.name };
}

/** Whether the member is a node whose dataset the run in flight may still
 * replace, for the reads' renewal when it settles. */
export function isNode(member: CanvasMember | null): member is NodeMember {
  return !!member && member.kind === "node";
}

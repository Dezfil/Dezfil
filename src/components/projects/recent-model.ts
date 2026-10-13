import type { MapOverview, TableListing } from "../api";
import { membershipNames } from "../scope/model";
import { ownedByOther, type PersonLabel } from "../sharing/people";
import { geometryChipLabel } from "../table-chips";
import { nodeWord, type WorkflowListing } from "../workflow-model";

/**
 * The empty home's recent list: the six latest eligible objects across
 * the whole workspace, using general update time for maps and workflows
 * and imported or created time for datasets, this project's members excluded, builder-origin
 * recipes never counted. Someone else's work carries its owner, and only
 * the reader's own work is theirs to move or add, as in the picker. A
 * host with no project leaves nothing out for being filed, and may ask
 * for equal times to order the same whatever order the lists answered
 * in. Pure: the component only presents.
 */

/** `owner`: the owner of someone else's work, null on the reader's own. */
type RecentBase = { id: string; name: string; time: string; where: string[]; fact: string; owner: PersonLabel | null };
export type RecentItem =
  | (RecentBase & { kind: "map"; map: MapOverview })
  | (RecentBase & { kind: "workflow"; workflow: WorkflowListing })
  | (RecentBase & { kind: "dataset"; table: TableListing });

export const RECENT_LIMIT = 6;

export const KIND_WORD: Record<RecentItem["kind"], string> = {
  map: "Map",
  workflow: "Workflow",
  dataset: "Dataset",
};

/** The project names an object lives in, alphabetical; a project the
 * directory cannot name is one the reader no longer reaches, said without
 * a name, never invented; empty means not in a project. */
export function whereNames(
  projectIds: readonly (string | null)[],
  names: Map<string, string>,
): string[] {
  return membershipNames(
    projectIds.filter((id): id is string => id !== null),
    names,
  );
}

/** The one line: "in A, B" or "not in a project". */
export function whereLine(where: string[]): string {
  return where.length ? `in ${where.join(", ")}` : "not in a project";
}

const layers = (n: number) => `${n} layer${n === 1 ? "" : "s"}`;
const rows = (n: number) => `${n.toLocaleString("en-US")} row${n === 1 ? "" : "s"}`;

/** Identities a host leaves out, whatever their membership. */
export type RecentExclusion = {
  maps: ReadonlySet<string>;
  workflows: ReadonlySet<string>;
  tables: ReadonlySet<string>;
};

const NOTHING: RecentExclusion = { maps: new Set(), workflows: new Set(), tables: new Set() };

export function recentItems(input: {
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
  /** This project: its members are excluded, by their own membership
   * and by the home's member ids alike. Without one, being filed leaves
   * nothing out. */
  projectId?: string;
  exclude?: RecentExclusion;
  names: Map<string, string>;
  limit?: number;
  /** The signed-in person's SQL name; unknown, nothing is marked. */
  me?: string | null;
  /** Equal times: "listed" (the default) keeps the order the lists
   * answered in, maps before workflows before datasets; "total" orders
   * them map, workflow, dataset, then the lower identity, the same
   * whatever order the lists answered in. */
  ties?: "listed" | "total";
}): RecentItem[] {
  const { names, projectId, me = null, exclude = NOTHING } = input;
  const ownerOf = (item: { owner?: PersonLabel | null }) => (ownedByOther(item.owner, me) ? item.owner : null);
  const filedHere = (id: string | null) => projectId !== undefined && id === projectId;
  const items: RecentItem[] = [];
  for (const m of input.maps) {
    if (filedHere(m.projectId) || exclude.maps.has(m.id)) continue;
    items.push({
      kind: "map",
      id: m.id,
      name: m.name,
      time: m.updatedAt,
      where: whereNames([m.projectId], names),
      fact: layers(m.layerCount),
      owner: ownerOf(m),
      map: m,
    });
  }
  for (const w of input.workflows) {
    if (w.origin !== "workflow" || filedHere(w.projectId) || exclude.workflows.has(w.id)) continue;
    items.push({
      kind: "workflow",
      id: w.id,
      name: w.name,
      time: w.updatedAt,
      where: whereNames([w.projectId], names),
      fact: `${w.summary.nodes} ${nodeWord(w.summary.nodes)}`,
      owner: ownerOf(w),
      workflow: w,
    });
  }
  for (const t of input.tables) {
    if (t.projectIds.some((id) => filedHere(id)) || exclude.tables.has(t.id)) continue;
    items.push({
      kind: "dataset",
      id: t.id,
      name: t.name,
      time: t.importedAt ?? t.createdAt,
      where: whereNames(t.projectIds, names),
      fact: `${rows(t.rowCount)} · ${geometryChipLabel(t)}`,
      owner: ownerOf(t),
      table: t,
    });
  }
  // Newest first across kinds; a tie keeps the ruled kind order, which
  // is the order the items were pushed in (the sort is stable), unless
  // the host asks for the total order.
  const newest = (a: RecentItem, b: RecentItem) => b.time.localeCompare(a.time);
  return items
    .sort(input.ties === "total" ? (a, b) => newest(a, b) || totalTie(a, b) : newest)
    .slice(0, input.limit ?? RECENT_LIMIT);
}

const KIND_ORDER: Record<RecentItem["kind"], number> = { map: 0, workflow: 1, dataset: 2 };

/** Equal times in the total order: map, workflow, dataset, then the lower
 * identity. */
function totalTie(a: RecentItem, b: RecentItem): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The card's heading: the instance by name, or plain when unnamed. */
export function recentHeading(instanceName: string | null): string {
  return instanceName ? `Recent in ${instanceName}` : "Recent";
}

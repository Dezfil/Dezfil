import type { MapOverview, TableListing } from "../api";
import { geometryChipLabel } from "../table-chips";
import { nodeWord, type WorkflowListing } from "../workflow-model";

/**
 * The empty home's recent list: the six latest eligible objects across
 * the whole workspace, each kind timed by the fact its own page already
 * shows (a map's and a workflow's edited time, a dataset's imported or
 * created time), this project's members excluded, builder-origin
 * recipes never counted. Pure: the component only presents.
 */

export type RecentItem =
  | { kind: "map"; id: string; name: string; time: string; where: string[]; fact: string; map: MapOverview }
  | { kind: "workflow"; id: string; name: string; time: string; where: string[]; fact: string; workflow: WorkflowListing }
  | { kind: "dataset"; id: string; name: string; time: string; where: string[]; fact: string; table: TableListing };

export const RECENT_LIMIT = 6;

export const KIND_WORD: Record<RecentItem["kind"], string> = {
  map: "Map",
  workflow: "Workflow",
  dataset: "Dataset",
};

/** The project names an object lives in, alphabetical; unknown names
 * omitted, never invented; empty means not in a project. */
export function whereNames(
  projectIds: readonly (string | null)[],
  names: Map<string, string>,
): string[] {
  return projectIds
    .map((id) => (id ? names.get(id) : undefined))
    .filter((n): n is string => typeof n === "string")
    .sort((a, b) => a.localeCompare(b));
}

/** The one line: "in A, B" or "not in a project". */
export function whereLine(where: string[]): string {
  return where.length ? `in ${where.join(", ")}` : "not in a project";
}

const layers = (n: number) => `${n} layer${n === 1 ? "" : "s"}`;

export function recentItems(input: {
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
  /** This project: its members are excluded, by their own membership
   * and by the home's member ids alike. */
  projectId: string;
  exclude: { maps: Set<string>; workflows: Set<string>; tables: Set<string> };
  names: Map<string, string>;
  limit?: number;
}): RecentItem[] {
  const { names, projectId } = input;
  const items: RecentItem[] = [];
  for (const m of input.maps) {
    if (m.projectId === projectId || input.exclude.maps.has(m.id)) continue;
    items.push({
      kind: "map",
      id: m.id,
      name: m.name,
      time: m.updatedAt,
      where: whereNames([m.projectId], names),
      fact: layers(m.layerCount),
      map: m,
    });
  }
  for (const w of input.workflows) {
    if (w.origin !== "workflow" || w.projectId === projectId || input.exclude.workflows.has(w.id)) continue;
    items.push({
      kind: "workflow",
      id: w.id,
      name: w.name,
      time: w.updatedAt,
      where: whereNames([w.projectId], names),
      fact: `${w.summary.nodes} ${nodeWord(w.summary.nodes)}`,
      workflow: w,
    });
  }
  for (const t of input.tables) {
    if (t.projectIds.includes(projectId) || input.exclude.tables.has(t.id)) continue;
    items.push({
      kind: "dataset",
      id: t.id,
      name: t.name,
      time: t.importedAt ?? t.createdAt,
      where: whereNames(t.projectIds, names),
      fact: `${t.rowCount.toLocaleString("en-US")} rows · ${geometryChipLabel(t)}`,
      table: t,
    });
  }
  // Newest first across kinds; a tie keeps the ruled kind order, which
  // is the order the items were pushed in (the sort is stable).
  return items
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, input.limit ?? RECENT_LIMIT);
}

/** The card's heading: the instance by name, or plain when unnamed. */
export function recentHeading(instanceName: string | null): string {
  return instanceName ? `Recent in ${instanceName}` : "Recent";
}

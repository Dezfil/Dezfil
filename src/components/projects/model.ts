import type { MapOverview, TableListing } from "../api";
import { formatBytes } from "../api";
import type { WorkflowListing } from "../workflow-model";

/**
 * The Projects screens' client model: the overview wire shape and the
 * pure derivations the list renders from. The displayed workflow facts
 * NEVER come from the overview's recipe count — that count includes
 * builder-origin recipes (queued); they derive from the workflow-origin
 * listing, so the screens agree with the Workflows section of the app.
 */

export interface ProjectOverview {
  id: string;
  name: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  mapCount: number;
  publishedMapCount: number;
  recipeCount: number;
  tableCount: number;
  sizeBytes: number;
  sizeComplete: boolean;
}

export type ProjectsSort = "updated" | "name" | "largest";
export const PROJECT_SORTS = ["updated", "name", "largest"] as const;

export function sortProjects(
  list: ProjectOverview[],
  sort: ProjectsSort,
): ProjectOverview[] {
  return [...list].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    // Largest orders by the known sum; a partial sum is still the
    // displayed (and marked) number, so it orders by what it shows.
    if (sort === "largest") return b.sizeBytes - a.sizeBytes;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function filterProjects(
  list: ProjectOverview[],
  query: string,
): ProjectOverview[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q));
}

/** The size as displayed: honest about a partial sum. */
export function sizeLabel(p: {
  sizeBytes: number;
  sizeComplete: boolean;
}): string {
  const size = formatBytes(p.sizeBytes);
  return p.sizeComplete ? size : `≥ ${size}`;
}

/** Per-project workflow counts from the workflow-origin listing — the
 * displayed number, never the overview's recipe count. */
export function workflowCounts(
  workflows: Pick<WorkflowListing, "projectId">[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of workflows) {
    if (!w.projectId) continue;
    counts.set(w.projectId, (counts.get(w.projectId) ?? 0) + 1);
  }
  return counts;
}

/** The unfiled strip's counts. */
export function unfiledCounts(input: {
  maps: Pick<MapOverview, "projectId">[];
  workflows: Pick<WorkflowListing, "projectId">[];
  unfiledDatasets: number;
}): { maps: number; workflows: number; datasets: number; any: boolean } {
  const maps = input.maps.filter((m) => !m.projectId).length;
  const workflows = input.workflows.filter((w) => !w.projectId).length;
  const datasets = input.unfiledDatasets;
  return { maps, workflows, datasets, any: maps + workflows + datasets > 0 };
}

/* The picture by count, the counts that drop zeros ---- */

/** One tile of a project's picture: a map or a workflow — datasets take
 * no tile. */
export type PictureItem =
  | { kind: "map"; map: MapOverview }
  | { kind: "workflow"; workflow: WorkflowListing };

export const PICTURE_TILES = 4;

/** Up to four members per project in the ruled order — every map
 * first, then workflows while places remain, each kind in its listing's
 * own documented order (a recorded departure edited-time sort of the
 * maps-only mosaic); datasets never take a tile. A project with neither
 * has no entry: its picture is the folder tile, whatever data it holds.
 * */
export function projectPictures(members: {
  maps: MapOverview[];
  workflows: WorkflowListing[];
}): Map<string, PictureItem[]> {
  const grouped = new Map<string, PictureItem[]>();
  const push = (id: string | null, item: PictureItem) => {
    if (!id) return;
    const list = grouped.get(id) ?? [];
    if (list.length < PICTURE_TILES) list.push(item);
    grouped.set(id, list);
  };
  for (const m of members.maps) push(m.projectId, { kind: "map", map: m });
  for (const w of members.workflows) {
    push(w.projectId, { kind: "workflow", workflow: w });
  }
  return grouped;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The card's counts line: a kind only when the
 * project has one, the size only with a dataset; null means not shown. */
export function cardCounts(
  p: Pick<ProjectOverview, "mapCount" | "tableCount" | "sizeBytes" | "sizeComplete">,
  workflowCount: number,
): {
  maps: number | null;
  workflows: number | null;
  datasets: number | null;
  size: string | null;
} {
  return {
    maps: p.mapCount > 0 ? p.mapCount : null,
    workflows: workflowCount > 0 ? workflowCount : null,
    datasets: p.tableCount > 0 ? p.tableCount : null,
    size: p.tableCount > 0 ? sizeLabel(p) : null,
  };
}

/** The list row's Contents column: each non-zero kind with its word. */
export function contentsWords(
  p: Pick<ProjectOverview, "mapCount" | "tableCount">,
  workflowCount: number,
): string[] {
  const out: string[] = [];
  if (p.mapCount > 0) out.push(count(p.mapCount, "map"));
  if (workflowCount > 0) out.push(count(workflowCount, "workflow"));
  if (p.tableCount > 0) out.push(count(p.tableCount, "dataset"));
  return out;
}

/** A project with no member of any kind — the card and row say so. */
export function isEmptyProject(
  p: Pick<ProjectOverview, "mapCount" | "tableCount">,
  workflowCount: number,
): boolean {
  return p.mapCount === 0 && workflowCount === 0 && p.tableCount === 0;
}
export const EMPTY_WORD = "Empty";

/** The unfiled dataset count from the whole listing (the wider read
 * the picture needs), the same number the scoped read gave. */
export function unfiledDatasetCount(
  tables: Pick<TableListing, "projectIds">[],
): number {
  return tables.filter((t) => t.projectIds.length === 0).length;
}

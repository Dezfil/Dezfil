import type { MapOverview, TableListing } from "../api";
import { geometryChipLabel } from "../table-chips";
import { nodeWord, type WorkflowListing } from "../workflow-model";
import { addable, distinctProducers, type DependencyWire } from "./add-model";
import { whereNames } from "./recent-model";
import type { FilingBases } from "./filing-intent";

/**
 * The project-first picker's pure model (the ruled): what is eligible
 * per tab, the search, the selection kept across tabs, and the one
 * composed membership change with its truthful summary. Bring-along
 * follows the shipped filing rules (add-model): a map brings its
 * datasets and their distinct workflow-origin producers, a workflow
 * brings the datasets it reads and writes, a dataset brings nothing.
 * Shared dependencies count and change once. It is a picker of one's own
 * work: it offers one's own maps, workflows and datasets, and brings only
 * one's own; another person's dependency is named as not one's to add and
 * never sent. The dialog only presents.
 */

export type PickKind = "map" | "workflow" | "dataset";

export type PickItem =
  | { kind: "map"; id: string; name: string; where: string[]; fact: string; map: MapOverview }
  | { kind: "workflow"; id: string; name: string; where: string[]; fact: string; workflow: WorkflowListing }
  | { kind: "dataset"; id: string; name: string; where: string[]; fact: string; table: TableListing };

export interface PickerLists {
  maps: PickItem[];
  workflows: PickItem[];
  datasets: PickItem[];
}

/** Everything not already in this project, per kind, in listing order;
 * builder-origin recipes never appear. */
export function pickerItems(input: {
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
  projectId: string;
  names: Map<string, string>;
  /** The signed-in person's SQL name: someone else's work is not theirs
   * to file, so it is not offered. */
  me?: string | null;
}): PickerLists {
  const { names, projectId, me = null } = input;
  const own = (item: { owner?: { sqlName: string } }) =>
    me === null || !item.owner || item.owner.sqlName === me;
  return {
    maps: input.maps
      .filter(own)
      .filter((m) => m.projectId !== projectId)
      .map((m) => ({
        kind: "map",
        id: m.id,
        name: m.name,
        where: whereNames([m.projectId], names),
        fact: `${m.layerCount} layer${m.layerCount === 1 ? "" : "s"}`,
        map: m,
      })),
    workflows: input.workflows
      .filter(own)
      .filter((w) => w.origin === "workflow" && w.projectId !== projectId)
      .map((w) => ({
        kind: "workflow",
        id: w.id,
        name: w.name,
        where: whereNames([w.projectId], names),
        fact: `${w.summary.nodes} ${nodeWord(w.summary.nodes)}`,
        workflow: w,
      })),
    datasets: input.tables
      .filter(own)
      .filter((t) => !t.projectIds.includes(projectId))
      .map((t) => ({
        kind: "dataset",
        id: t.id,
        name: t.name,
        where: whereNames(t.projectIds, names),
        fact: `${t.rowCount.toLocaleString("en-US")} rows · ${geometryChipLabel(t)}`,
        table: t,
      })),
  };
}

/** The rows matching the search, case-insensitively, by name. */
export function searchItems<T extends { name: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
}

export interface Selection {
  maps: Set<string>;
  workflows: Set<string>;
  datasets: Set<string>;
}

export const emptySelection = (): Selection => ({
  maps: new Set(),
  workflows: new Set(),
  datasets: new Set(),
});

export function selectionCount(sel: Selection): number {
  return sel.maps.size + sel.workflows.size + sel.datasets.size;
}

/** A selected map's or workflow's dependency read, cached per object. */
export type DepsRead =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "ready"; deps: DependencyWire[] };

export interface Composed {
  bases: FilingBases;
  members: { addMaps?: string[]; addRecipes?: string[]; addTables?: string[] };
  summary: { maps: number; workflows: number; datasets: number; brought: number };
  /** Selected maps and workflows whose bring-along set is not known:
   * confirmation waits on them, never files them with an empty set. */
  blocked: string[];
}

/** The destination's current members: what it already holds neither
 * counts as brought nor is sent again. */
export interface Members {
  workflows: ReadonlySet<string>;
  tables: ReadonlySet<string>;
}
const NO_MEMBERS: Members = { workflows: new Set(), tables: new Set() };

/** One truthful change: the selection plus every object it brings that
 * the project does not already hold, each counted and sent once. */
export function composeChange(
  sel: Selection,
  reads: Map<string, DepsRead>,
  held: Members = NO_MEMBERS,
  displayed: FilingBases = {},
): Composed {
  const bases: FilingBases = {};
  for (const id of sel.maps) if (displayed[`map:${id}`]) bases[`map:${id}`] = displayed[`map:${id}`];
  for (const id of sel.workflows) if (displayed[`workflow:${id}`]) bases[`workflow:${id}`] = displayed[`workflow:${id}`];
  const recipes = new Set<string>(sel.workflows);
  const tables = new Set<string>(sel.datasets);
  const blocked: string[] = [];
  const addTable = (id: string) => {
    if (!held.tables.has(id)) tables.add(id);
  };
  for (const id of sel.maps) {
    const read = reads.get(id);
    if (!read || read.status !== "ready") {
      blocked.push(id);
      continue;
    }
    const mine = read.deps.filter(addable);
    for (const d of mine) addTable(d.id);
    for (const p of distinctProducers(mine, new Set(mine.map((d) => d.id)))) {
      if (p.owned !== false && !held.workflows.has(p.id)) {
        recipes.add(p.id);
        if (p.editRevision && !bases[`workflow:${p.id}`]) bases[`workflow:${p.id}`] = p.editRevision;
      }
    }
  }
  for (const id of sel.workflows) {
    const read = reads.get(id);
    if (!read || read.status !== "ready") {
      blocked.push(id);
      continue;
    }
    for (const d of read.deps.filter(addable)) addTable(d.id);
  }
  const brought =
    [...recipes].filter((id) => !sel.workflows.has(id)).length +
    [...tables].filter((id) => !sel.datasets.has(id)).length;
  const members: Composed["members"] = {};
  if (sel.maps.size) members.addMaps = [...sel.maps];
  if (recipes.size) members.addRecipes = [...recipes];
  if (tables.size) members.addTables = [...tables];
  return {
    bases,
    members,
    summary: {
      maps: sel.maps.size,
      workflows: sel.workflows.size,
      datasets: sel.datasets.size,
      brought,
    },
    blocked,
  };
}

const word = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The footer's status: what is picked and what it brings. */
export function pickerStatus(summary: Composed["summary"]): string {
  const parts: string[] = [];
  if (summary.maps) parts.push(word(summary.maps, "map"));
  if (summary.workflows) parts.push(word(summary.workflows, "workflow"));
  if (summary.datasets) parts.push(word(summary.datasets, "dataset"));
  if (!parts.length) return "Nothing picked";
  if (summary.brought) parts.push(`${summary.brought} they bring`);
  return parts.join(" · ");
}

/** The confirm button's label: every object that will join, counted once. */
export function pickerLabel(summary: Composed["summary"]): string {
  const total =
    summary.maps + summary.workflows + summary.datasets + summary.brought;
  return `Add ${word(total, "item")}`;
}

/** What a picked map or workflow brings, by name, and what it depends on
 * that is someone else's, by the name its reader types: named, never sent. */
export function bringAlong(deps: DependencyWire[]): { brings: string[]; notYours: string[] } {
  return {
    brings: deps.filter(addable).map((d) => d.name),
    notYours: deps.filter((d) => !addable(d)).map((d) => d.qualifiedName ?? d.name),
  };
}

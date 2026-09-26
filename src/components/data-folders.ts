/**
 * Workflow folders on the Data page: the fold of the two listings the
 * page reads, tables and recipes, into one ordered set of items — loose
 * tables and folders. Pure, so the identity rule, the orphan rule, the
 * sums, the sort keys and the filter and search rules (behaviours 1, 2,
 * 4 and 5) are held here without a browser. The screen renders the items
 * and decides nothing about membership.
 */

import type { TableListing } from "./api";
import type { WorkflowListing } from "./workflow-model";

export type DataSort = "updated" | "name" | "rows" | "size";
export type SourceFilter = "all" | TableListing["source"];

export interface LooseTable {
  kind: "table";
  table: TableListing;
}

export interface DataFolder {
  kind: "folder";
  /** The workflow's id: the folder's identity on the page. */
  id: string;
  name: string;
  workflow: WorkflowListing;
  /** Every current output of the workflow that the tables listing holds. */
  outputs: TableListing[];
  /** The outputs the pane shows under the current search:
   * all of them unless an output-name search narrows it. */
  matching: TableListing[];
  rows: number;
  /** The summed size, or null when any output's size is unavailable. */
  bytes: number | null;
  /** The newest output's time. */
  updatedAt: string;
}

export type DataItem = LooseTable | DataFolder;

/** When a table last changed: the import run if there was one. */
export function updatedAt(t: TableListing): string {
  return t.importedAt ?? t.createdAt;
}

/**
 * The fold (behaviours 1 and 2): each workflow-origin recipe with at
 * least one current output the tables listing holds becomes a folder;
 * membership is by the output's table id, never its name, so a new table
 * that reuses a deleted output's name and an output whose node is gone
 * stay loose. With no workflows read yet, every table is loose. A table
 * claimed by two workflows goes to the first; it is never listed twice.
 */
export function foldTables(
  tables: TableListing[],
  workflows: WorkflowListing[] | null,
): DataItem[] {
  const byId = new Map(tables.map((t) => [t.id, t]));
  const taken = new Set<string>();
  const folders: DataFolder[] = [];
  for (const w of workflows ?? []) {
    if (w.origin !== "workflow") continue;
    const outputs: TableListing[] = [];
    for (const step of w.steps) {
      const id = step.output?.id;
      if (!id || taken.has(id)) continue;
      const table = byId.get(id);
      if (!table) continue;
      taken.add(id);
      outputs.push(table);
    }
    if (outputs.length === 0) continue;
    folders.push(folderOf(w, outputs, outputs));
  }
  const loose: DataItem[] = tables
    .filter((t) => !taken.has(t.id))
    .map((t) => ({ kind: "table", table: t }));
  return [...loose, ...folders];
}

function folderOf(
  workflow: WorkflowListing,
  outputs: TableListing[],
  matching: TableListing[],
): DataFolder {
  let bytes: number | null = 0;
  for (const t of outputs) {
    if (bytes === null) break;
    bytes = t.sizeBytes === null || t.sizeBytes === undefined ? null : bytes + t.sizeBytes;
  }
  return {
    kind: "folder",
    id: workflow.id,
    name: workflow.name,
    workflow,
    outputs,
    matching,
    rows: outputs.reduce((sum, t) => sum + t.rowCount, 0),
    bytes,
    updatedAt: outputs.map(updatedAt).reduce((a, b) => (b > a ? b : a)),
  };
}

/** The shipped sort over tables, unchanged. */
export function sortTables(tables: TableListing[], sort: DataSort): TableListing[] {
  return [...tables].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "rows") return b.rowCount - a.rowCount;
    if (sort === "size") return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
    return updatedAt(b).localeCompare(updatedAt(a));
  });
}

/**
 * What the page shows (behaviours 4 and 5): the filter, the search and
 * the sort over folders and loose tables together. Results keeps the
 * folders and the loose operation results; every other source keeps
 * that source's loose tables and no folder. A workflow-name match shows
 * the folder with every output, an output-name match with the matching
 * ones; the folder's facts stay the folder's. Inside a folder the
 * outputs follow the same sort.
 */
export function shownItems(
  items: DataItem[],
  opts: { query: string; filter: SourceFilter; sort: DataSort },
): DataItem[] {
  const q = opts.query.trim().toLowerCase();
  const kept: DataItem[] = [];
  for (const item of items) {
    if (item.kind === "table") {
      const t = item.table;
      if (opts.filter !== "all" && t.source !== opts.filter) continue;
      if (q && !t.name.toLowerCase().includes(q)) continue;
      kept.push(item);
      continue;
    }
    if (opts.filter !== "all" && opts.filter !== "operation") continue;
    let matching = item.outputs;
    if (q && !item.name.toLowerCase().includes(q)) {
      matching = item.outputs.filter((t) => t.name.toLowerCase().includes(q));
      if (matching.length === 0) continue;
    }
    kept.push({ ...item, matching: sortTables(matching, opts.sort) });
  }
  return kept.sort((a, b) => compareItems(a, b, opts.sort));
}

function compareItems(a: DataItem, b: DataItem, sort: DataSort): number {
  if (sort === "name") return nameOf(a).localeCompare(nameOf(b));
  if (sort === "rows") return rowsOf(b) - rowsOf(a);
  if (sort === "size") return bytesOf(b) - bytesOf(a);
  return timeOf(b).localeCompare(timeOf(a));
}

const nameOf = (i: DataItem) => (i.kind === "table" ? i.table.name : i.name);
const rowsOf = (i: DataItem) => (i.kind === "table" ? i.table.rowCount : i.rows);
/** An unavailable size orders as the shipped sort orders it: as nothing. */
const bytesOf = (i: DataItem) => (i.kind === "table" ? (i.table.sizeBytes ?? 0) : (i.bytes ?? 0));
const timeOf = (i: DataItem) => (i.kind === "table" ? updatedAt(i.table) : i.updatedAt);

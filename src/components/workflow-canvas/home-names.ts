import type { TableListing } from "../api";
import { normalName, readTarget } from "../workflow-producers";
import { listedFor, type CanvasGraph } from "./graph";
import { memberByName } from "./link-rules";

/**
 * Names on the canvas are written in the workflow's SQL home: a plain name
 * is the workflow's own output of that name, else the home's dataset, and
 * `<sql name>.<dataset>` is that person's. A reader's listing holds their
 * own datasets under plain names and everyone else's qualified, and two
 * people's same-named datasets both appear in it. So a listed dataset is
 * rewritten for the home before the canvas stores it, and a stored name is
 * found in the listing by its owner, never by the bare name alone.
 */

/** The name a listed dataset goes by in the workflow's home: plain when the
 * home owns it, else qualified with its owner's SQL name. With no home
 * known, the reader is taken for the home and their typed name stands. */
export function writtenInHome(table: TableListing, home: string | null | undefined): string {
  const owner = table.owner?.sqlName;
  if (!home || !owner) return typedName(table);
  return owner.toLowerCase() === home.toLowerCase() ? table.name : `${owner}.${table.name}`;
}

/** A dataset the reader has just imported, by its plain name, as the home
 * writes it: qualified with the reader's SQL name on someone else's
 * workflow, unchanged on their own or when either is unknown. */
export function importedInHome(name: string, reader: string | null | undefined, home: string | null | undefined): string {
  if (!reader || !home || reader.toLowerCase() === home.toLowerCase()) return name;
  return `${reader}.${name}`;
}

/** The name the reader types for a listed dataset: their own plain, anyone
 * else's qualified. */
export function typedName(table: TableListing): string {
  return table.qualifiedName ?? table.name;
}

/** Whether the reader owns a listed dataset: their own is listed under its
 * plain name. An entry that carries no owner is taken for the reader's. */
function readersOwn(table: TableListing): boolean {
  return !table.owner || !table.qualifiedName || table.qualifiedName === table.name;
}

/** The listed datasets the canvas's members already hold, by identity:
 * each source's dataset and each node's produced output. */
export function heldTableIds(graph: CanvasGraph): Set<string> {
  const held = new Set<string>();
  for (const m of graph.members) {
    if (m.kind === "source" && m.tableId) held.add(m.tableId);
    if (m.kind === "node" && m.step.output?.id) held.add(m.step.output.id);
  }
  return held;
}

/** A row of the pane's Sources: the name the reader types for the dataset,
 * the name a drop writes in the home, and the source on the canvas that
 * holds this very dataset, if one does. */
export function paneRow(
  table: TableListing,
  graph: CanvasGraph,
): { typed: string; written: string; here: boolean; sourceId: string | null } {
  const holder = graph.members.find((m) => m.kind === "source" && m.tableId === table.id) ?? null;
  return { typed: typedName(table), written: writtenInHome(table, graph.home), here: holder !== null, sourceId: holder?.id ?? null };
}

/**
 * A declared output's name is taken when a dataset of that name is in
 * either space it meets: the workflow's home, where a plain name would
 * shadow it, and the declaring reader's own, where their run lands it.
 * Another person's dataset that merely shares the name takes nothing.
 */
export function outputNameTaken(tables: readonly TableListing[], home: string | null | undefined): (name: string) => boolean {
  return (name: string) =>
    tables.some(
      (t) =>
        normalName(t.name) === normalName(name) &&
        (readersOwn(t) || !home || t.owner?.sqlName?.toLowerCase() === home.toLowerCase()),
    );
}

/**
 * The address the reader asks with for the dataset a stored name points
 * at, for what is read on their behalf (a field's columns): a node's
 * produced output by its identity, else the listed dataset the name points
 * at in the home, by the name the reader types for it. A name the listing
 * does not hold is asked for in the home, so a plain name never falls to
 * the reader's own same-named dataset.
 */
export function readerAddressOf(name: string, graph: CanvasGraph, tables: readonly TableListing[]): string {
  const member = memberByName(graph, name);
  if (member?.kind === "node" && member.step.output) {
    const out = tables.find((t) => t.id === member.step.output!.id);
    if (out) return typedName(out);
  }
  const listed = listedFor(tables, name, graph.home);
  if (listed) return typedName(listed);
  return readTarget(name).owner === null && graph.home ? `${graph.home}.${name}` : name;
}

import type { TableListing } from "../api";
import { normalName } from "../workflow-producers";
import type { CanvasGraph, NodeMember, SourceMember } from "./graph";

/**
 * What removing a member would do, said before it is done. The
 * confirmation is truthful for the node's state: a dataset that exists
 * stays and its readers go on reading it as a workspace table; a deleted
 * one promises nothing; a never-run node has none, and a sibling reading
 * its declared output stays bound to a name nothing produces. A loose
 * source that nothing needs goes without asking; one a read or a lineage
 * needs is not removable, and the reason is said.
 */

export type DatasetState = "exists" | "deleted" | "never";

export interface RemovalPlan {
  state: DatasetState;
  dataset: string | null;
  readers: { id: string; label: string }[];
  /** The confirmation's body, one or two sentences. */
  sentence: string;
}

function readersOf(member: NodeMember, graph: CanvasGraph): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const e of graph.edges) {
    if (e.from !== member.id || e.time === "lineage") continue;
    const to = graph.members.find((m) => m.id === e.to);
    if (to && to.kind === "node" && !out.some((r) => r.id === to.id)) out.push({ id: to.id, label: to.label });
  }
  return out;
}

function list(readers: { label: string }[]): string {
  const names = readers.map((r) => r.label);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function removalPlan(member: NodeMember, graph: CanvasGraph, tables: TableListing[]): RemovalPlan {
  const step = member.step;
  const readers = readersOf(member, graph);
  const produced = step.output;
  if (produced && produced.name) {
    const listed = tables.some((t) => normalName(t.name) === normalName(produced.name!)) && !step.conditions.includes("output_missing");
    if (listed) {
      const who = readers.length ? ` ${list(readers)} ${readers.length === 1 ? "goes" : "go"} on reading it as a workspace table.` : "";
      return { state: "exists", dataset: produced.name, readers, sentence: `The dataset ${produced.name} stays.${who}` };
    }
    const who = readers.length ? ` ${list(readers)} will find the name missing.` : "";
    return { state: "deleted", dataset: produced.name, readers, sentence: `Its dataset ${produced.name} was deleted, so nothing is kept.${who}` };
  }
  const declared = member.outputName;
  const who = readers.length
    ? ` ${list(readers)} ${readers.length === 1 ? "reads" : "read"} ${declared} and ${readers.length === 1 ? "stays" : "stay"} bound to a name nothing produces.`
    : "";
  return { state: "never", dataset: null, readers, sentence: `It has made no dataset.${who}` };
}

/** Why a source cannot leave the canvas; null when it can. */
export function sourceKeptBecause(member: SourceMember, graph: CanvasGraph): string | null {
  const reads = graph.edges.some((e) => e.from === member.id && e.time !== "lineage");
  if (reads) return `${member.name} stays: a node reads it.`;
  const lineage = graph.edges.some((e) => e.from === member.id && e.time === "lineage");
  if (lineage) return `${member.name} stays: a node’s recorded lineage names it.`;
  if (!member.loose) return `${member.name} stays: the recipe names it.`;
  return null;
}

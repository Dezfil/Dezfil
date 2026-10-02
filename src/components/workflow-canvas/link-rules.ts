import type { OperationDef, OperationInput } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { normalName, readKey, readTarget } from "../workflow-producers";
import type { CanvasGraph, CanvasMember, NodeMember, SourceMember } from "./graph";
import {
  classOfTable,
  type GeometryClass,
} from "../geometry-class";

export { classOfTable, type GeometryClass } from "../geometry-class";

/**
 * The link rules the canvas applies before an edit is sent: an echo of
 * the catalog's published acceptance and of the engine's backward-only
 * rule, never a second rule. The API's refusal is the last word; these
 * say it earlier, in the same terms.
 */

/** What a member's output holds, as far as it can be known before a run:
 * a source's table; a node's produced dataset, or its verb's declared
 * output geometry, following a named input where it passes one through;
 * unknown for a probed verb until it runs. */
export function expectedClass(
  member: CanvasMember,
  graph: CanvasGraph,
  operations: OperationDef[],
  tables: TableListing[],
  depth = 0,
): GeometryClass {
  if (member.kind === "source") {
    return member.table ? classOfTable(member.table) : "unknown";
  }
  const produced = member.step.output ? tables.find((t) => t.id === member.step.output!.id) : null;
  if (produced) return classOfTable(produced);
  const op = operations.find((o) => o.id === member.step.operation);
  if (!op || depth > 20) return "unknown";
  const out = op.outputGeometry;
  if (out.kind === "none") return "none";
  if (out.kind === "fixed") return out.geometry;
  if (out.kind === "from_input") {
    const params = member.step.proposedParameters ?? member.step.parameters;
    const name = params[out.input];
    if (typeof name !== "string" || name === "") return "unknown";
    const upstream = memberByName(graph, name);
    return upstream ? expectedClass(upstream, graph, operations, tables, depth + 1) : "unknown";
  }
  return "unknown";
}

/** The member a table name resolves to: a node that answers to it, or the
 * source that carries it. A qualified name, `<sql name>.<dataset>`, is that
 * person's dataset and never a node's output, whatever its sanitized form
 * spells. */
export function memberByName(graph: CanvasGraph, name: string): CanvasMember | null {
  if (readTarget(name).owner === null) {
    const key = normalName(name);
    for (const m of graph.members) {
      if (m.kind === "node") {
        const names = [m.step.output?.name, m.step.parameters.name, m.step.proposedParameters?.name].filter(
          (n): n is string => typeof n === "string" && n !== "",
        );
        if (names.some((n) => normalName(n) === key)) return m;
      }
    }
  }
  const key = readKey(name);
  return graph.members.find((m) => m.kind === "source" && readKey(m.name) === key) ?? null;
}

/** The catalog's acceptance, asked of a class rather than a table: `any`
 * takes all; `none` takes only a table without geometry; a probed class
 * is unknown until the run and is accepted. */
export function acceptsClass(accepts: readonly string[], held: GeometryClass): boolean {
  if (accepts.includes("any")) return true;
  if (accepts.includes("none")) return held === "none";
  if (held === "none") return false;
  if (held === "unknown") return true;
  return accepts.includes(held);
}

/** Whether `fromId` depends, transitively, on `toId`: a link from `from`
 * into `to` would then make a cycle. */
export function reaches(graph: CanvasGraph, fromId: string, toId: string): boolean {
  const upstream = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.time === "lineage") continue;
    const list = upstream.get(e.to) ?? [];
    list.push(e.from);
    upstream.set(e.to, list);
  }
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === toId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const up of upstream.get(id) ?? []) stack.push(up);
  }
  return false;
}

/** The name a member's output goes by when read: a source's table, a
 * node's produced dataset or its declared name. */
export function outputNameOf(member: CanvasMember): string | null {
  if (member.kind === "source") return member.name;
  return member.outputName || null;
}

/**
 * Why a link from a member's output into a node's named input is refused,
 * or null when it may be made: the input's acceptance against the
 * member's class, the node's own output, a cycle, a missing source, an
 * unnamed producer.
 */
export function linkRefusal(args: {
  from: CanvasMember;
  to: NodeMember;
  port: string;
  graph: CanvasGraph;
  operations: OperationDef[];
  tables: TableListing[];
}): string | null {
  const { from, to, port, graph, operations, tables } = args;
  const op = operations.find((o) => o.id === to.step.operation);
  const input = op?.inputs.find((i) => i.name === port);
  if (!op || !input) return `${to.label} reads what its query names. Change the query instead.`;
  if (from.kind === "source" && (from as SourceMember).missing) {
    return `“${from.name}” does not exist. Nothing can read it until it is back.`;
  }
  const name = outputNameOf(from);
  if (!name) return `${to.label} cannot read a node whose output has no name yet.`;
  if (from.id === to.id) return `${to.label} cannot read its own output.`;
  if (from.kind === "node" && reaches(graph, from.id, to.id)) {
    return `That would make a loop: ${from.label} already depends on ${to.label}.`;
  }
  return classRefusal(input, name, expectedClass(from, graph, operations, tables));
}

/** The class sentence alone, for a table that is not a member yet. */
export function classRefusal(input: OperationInput, name: string, held: GeometryClass): string | null {
  if (acceptsClass(input.accepts, held)) return null;
  const what = held === "none" ? "no geometry" : held === "unknown" ? "geometry known after its run" : `${held} geometry`;
  return input.accepts.includes("none")
    ? `${input.label} takes a table without geometry; “${name}” holds ${what}.`
    : `${input.label} needs ${input.accepts.join(", ")} geometry; “${name}” holds ${what}.`;
}

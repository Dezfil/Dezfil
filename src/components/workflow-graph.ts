import type { WorkflowStep } from "./workflow-model";
import { producerOf, producersByName, readKey } from "./workflow-producers";

/**
 * The graph a card draws: sources and nodes laid out by dependency, edges
 * from each node's present reads. A layout, not a capability — the reads
 * come from the API; nothing is parsed here.
 */
export interface GraphNode {
  id: string;
  kind: "source" | "node";
  name: string;
  operation: string | null;
  condition: string | null;
  col: number;
  row: number;
}
export interface GraphEdge {
  from: string;
  to: string;
}
export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cols: number;
  rows: number;
}

export function workflowGraph(steps: WorkflowStep[]): WorkflowGraph {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  // A node is found by every name it answers to — the matcher the canvas
  // shares.
  const producer = producersByName(ordered);
  const sources = new Map<string, GraphNode>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const depth = new Map<string, number>();
  for (const s of ordered) {
    let d = 1;
    for (const read of s.reads) {
      const key = readKey(read);
      const p = producerOf(producer, read);
      if (p && p !== s.id) {
        d = Math.max(d, (depth.get(p) ?? 0) + 1);
        edges.push({ from: p, to: s.id });
        continue;
      }
      let src = sources.get(key);
      if (!src) {
        src = { id: `src:${key}`, kind: "source", name: read, operation: null, condition: null, col: 0, row: sources.size };
        sources.set(key, src);
      }
      edges.push({ from: src.id, to: s.id });
    }
    depth.set(s.id, d);
    const planned = s.output?.name ?? (typeof s.parameters.name === "string" ? s.parameters.name : "");
    nodes.push({ id: s.id, kind: "node", name: planned, operation: s.operation, condition: s.condition, col: d, row: 0 });
  }
  const perCol = new Map<number, number>();
  for (const n of nodes) {
    const r = perCol.get(n.col) ?? 0;
    n.row = r;
    perCol.set(n.col, r + 1);
  }
  const all = [...sources.values(), ...nodes];
  const cols = all.length ? Math.max(...all.map((n) => n.col)) + 1 : 0;
  const rows = Math.max(sources.size, ...perCol.values(), 0);
  return { nodes: all, edges, cols, rows };
}

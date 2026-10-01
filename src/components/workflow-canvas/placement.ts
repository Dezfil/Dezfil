import type { LayoutNote } from "@/lib/metadata/recipe-layouts";
import { readKey } from "../workflow-producers";
import { arrangeByDependency, placeBeside, type Positions } from "./arrange";
import type { CanvasGraph } from "./graph";

export type { LayoutNote };

/**
 * Where the members open: a written layout places every member it names,
 * and one it does not name goes beside the graph; an unwritten layout (no
 * write time) gets the dependency arrangement, in memory. Nothing here
 * writes; the coordinator does, on a completed move or Arrange.
 */

export interface LayoutRead {
  steps: Record<string, { x: number; y: number }>;
  sources: Record<string, { x: number; y: number }>;
  /** The notes as stored, in the document's order. */
  notes: LayoutNote[];
  updatedAt: string | null;
}

export function initialPositions(graph: CanvasGraph, layout: LayoutRead): Positions {
  if (layout.updatedAt === null) return arrangeByDependency(graph.members, graph.edges);
  const sourceAt = new Map(Object.entries(layout.sources).map(([name, p]) => [readKey(name), p]));
  const placed: Positions = {};
  const unplaced: string[] = [];
  for (const m of graph.members) {
    const at = m.kind === "node" ? layout.steps[m.id] : sourceAt.get(readKey(m.name));
    if (at) placed[m.id] = { x: at.x, y: at.y };
    else unplaced.push(m.id);
  }
  for (const id of unplaced) placed[id] = placeBeside(placed);
  return placed;
}

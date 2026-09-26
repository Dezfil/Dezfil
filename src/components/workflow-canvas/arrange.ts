import type { CanvasEdge, CanvasMember } from "./graph";

/**
 * Arrange by dependency, the reference's rule: sources in the first
 * column, then nodes by longest path from a source; within a column,
 * members ordered by the mean position of what feeds them (a barycentre),
 * so edges cross as little as a simple pass allows; columns centred
 * against the tallest. The measures are the reference's (reference 13): a
 * node is 144 wide, 114 tall; columns are one node plus 96 apart; rows 28
 * apart; the graph starts at (48, 40).
 *
 * Pure: positions in, positions out. Used for a workflow with no written
 * layout (in memory, never written) and for the Arrange action (written).
 */

export const NODE_W = 144;
export const NODE_H = 114;
const COL_GAP = 96;
const ROW_GAP = 28;
const ORIGIN = { x: 48, y: 40 };
export const GRID = 8;

export type Position = { x: number; y: number };
export type Positions = Record<string, Position>;

export const snap = (v: number) => Math.round(v / GRID) * GRID;

export function arrangeByDependency(members: CanvasMember[], edges: CanvasEdge[]): Positions {
  const feeds = new Map<string, string[]>();
  for (const e of edges) {
    // Lineage edges explain the past; the arrangement follows what is read now.
    if (e.time === "lineage") continue;
    const list = feeds.get(e.to) ?? [];
    list.push(e.from);
    feeds.set(e.to, list);
  }
  const depth = new Map<string, number>();
  for (const m of members) if (m.kind === "source") depth.set(m.id, 0);
  const nodes = members.filter((m) => m.kind === "node");
  // Steps are in recipe order, and dependencies only point backwards, so
  // one pass in order finds every longest path.
  for (const n of nodes) {
    let d = 1;
    for (const from of feeds.get(n.id) ?? []) {
      const fd = depth.get(from);
      if (fd !== undefined) d = Math.max(d, fd + 1);
    }
    depth.set(n.id, d);
  }
  const columns = new Map<number, CanvasMember[]>();
  for (const m of members) {
    const d = depth.get(m.id) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(m);
    columns.set(d, col);
  }
  const keys = [...columns.keys()].sort((a, b) => a - b);
  const centre = new Map<string, number>();
  const target: Positions = {};
  const heights: number[] = [];
  for (const k of keys) {
    const col = columns.get(k)!;
    const bary = (m: CanvasMember) => {
      const ps = (feeds.get(m.id) ?? []).map((f) => centre.get(f)).filter((v): v is number => v !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    const ordered = [...col].sort((a, b) => bary(a) - bary(b));
    let y = 0;
    for (const m of ordered) {
      target[m.id] = { x: ORIGIN.x + k * (NODE_W + COL_GAP), y };
      centre.set(m.id, y + NODE_H / 2);
      y += NODE_H + ROW_GAP;
    }
    heights.push(Math.max(0, y - ROW_GAP));
  }
  const tallest = Math.max(0, ...heights);
  keys.forEach((k, i) => {
    const offset = ORIGIN.y + (tallest - heights[i]) / 2;
    for (const m of columns.get(k)!) target[m.id] = { x: snap(target[m.id].x), y: snap(target[m.id].y + offset) };
  });
  return target;
}

/** A member the written layout does not place goes beside the graph: to
 * the right of everything placed, level with its top. */
export function placeBeside(placed: Positions): Position {
  const values = Object.values(placed);
  if (values.length === 0) return { x: ORIGIN.x, y: ORIGIN.y };
  const right = Math.max(...values.map((p) => p.x + NODE_W));
  const top = Math.min(...values.map((p) => p.y));
  return { x: snap(right + 80), y: snap(top) };
}

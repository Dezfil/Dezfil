import { describe, it, expect } from "vitest";
import { arrangeByDependency, placeBeside, NODE_W, NODE_H } from "./arrange";
import type { CanvasEdge, CanvasMember } from "./graph";

const src = (name: string): CanvasMember => ({ kind: "source", id: `src:${name}`, name, table: null, tableId: null, typedName: null, space: null, missing: false, loose: false, lineageOnly: false });
const node = (id: string): CanvasMember =>
  ({ kind: "node", id, label: id, group: null, symbol: "code", outputName: id, ports: [], sql: true, state: { word: "never run", tone: "muted", badge: null }, disclosure: "" }) as unknown as CanvasMember;
const edge = (from: string, to: string, time: CanvasEdge["time"] = "present"): CanvasEdge =>
  ({ id: `${from}->${to}`, from, to, table: from, attachment: { kind: "sql" }, time, broken: false, stale: false });

describe("arrange by dependency", () => {
  it("puts sources in the first column and nodes by longest path, snapped to the grid", () => {
    const members = [src("stations"), src("districts"), node("a"), node("b"), node("c")];
    const edges = [edge("src:stations", "a"), edge("src:districts", "b"), edge("a", "b"), edge("b", "c")];
    const p = arrangeByDependency(members, edges);
    const col = (id: string) => Math.round((p[id].x - 48) / (NODE_W + 96));
    expect([col("src:stations"), col("src:districts"), col("a"), col("b"), col("c")]).toEqual([0, 0, 1, 2, 3]);
    for (const v of Object.values(p)) {
      expect(v.x % 8).toBe(0);
      expect(v.y % 8).toBe(0);
    }
    // The two sources stack in their column: no overlap, and at most one
    // grid step over the reference's row gap once snapped.
    const dy = Math.abs(p["src:districts"].y - p["src:stations"].y);
    expect(dy).toBeGreaterThanOrEqual(NODE_H);
    expect(dy).toBeLessThanOrEqual(NODE_H + 28 + 8);
  });

  it("orders a column by what feeds it and ignores lineage edges", () => {
    const members = [src("x"), src("y"), node("a"), node("b")];
    // b is fed by y (lower), a by x (upper): the second column follows.
    const edges = [edge("src:x", "a"), edge("src:y", "b"), edge("src:y", "a", "lineage")];
    const p = arrangeByDependency(members, edges);
    expect(p.a.y).toBeLessThan(p.b.y);
    expect(p.a.x).toBe(p.b.x);
  });

  it("places an unplaced member beside the graph, or at the origin when nothing is placed", () => {
    expect(placeBeside({})).toEqual({ x: 48, y: 40 });
    const beside = placeBeside({ a: { x: 48, y: 200 }, b: { x: 288, y: 40 } });
    expect(beside.x).toBeGreaterThanOrEqual(288 + NODE_W + 80 - 8);
    expect(beside.y).toBe(40);
  });
});

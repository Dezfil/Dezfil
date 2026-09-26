import { describe, it, expect } from "vitest";
import { diffLayout, layoutInverse, words, type LayoutStep } from "./canvas-history";
import { nudgeDiagonal, nudgeFree, positionsOf, screenPositions, unechoedPlacements } from "./screen-positions";
import type { FlowNode } from "./to-flow";
import type { LayoutSnapshot } from "./use-layout-saves";

/**
 * Where the members sit on the screen ((d) and 3(f)): the tiles the
 * canvas shows and the placements no read has echoed yet, which is the
 * screen the record must read. Seen red against the composition that read
 * the tiles alone, where an immediate undo of a source's placement found
 * the source absent and dropped its step.
 */

const tile = (id: string, x: number, y: number): FlowNode =>
  ({ id, type: id.startsWith("src:") ? "source" : "badge", position: { x, y }, data: {} }) as unknown as FlowNode;
const note = (id: string, x: number, y: number): FlowNode => ({ id, type: "note", position: { x, y }, data: {} }) as unknown as FlowNode;

describe("the screen's positions", () => {
  it("holds a placement no read has echoed yet, and the notes' own nodes never", () => {
    const screen = screenPositions([tile("n1", 0, 0), note("note:k", 9, 9)], { "src:points": { x: 48, y: 40 } });
    expect(screen).toEqual({ n1: { x: 0, y: 0 }, "src:points": { x: 48, y: 40 } });
  });

  it("lets the tile win over the placement it was born with, since the member may have moved since", () => {
    const screen = screenPositions([tile("n1", 96, 40)], { n1: { x: 48, y: 40 } });
    expect(screen).toEqual({ n1: { x: 96, y: 40 } });
  });

  it("leaves a member on its way off the canvas out of both", () => {
    const screen = screenPositions([tile("n1", 0, 0)], { "src:points": { x: 48, y: 40 } }, "src:points");
    expect(screen).toEqual({ n1: { x: 0, y: 0 } });
    expect(screenPositions([tile("n1", 0, 0)], {}, "n1")).toEqual({});
  });

  it("undoes a source's placement inside the window before its read lands", () => {
    // The source is placed: the offer that records the step carries it,
    // and the canvas holds its spot in its placements until the layout's
    // answer brings the member into the graph.
    const before: LayoutSnapshot = { positions: { n1: { x: 0, y: 0 } }, notes: [] };
    const placements = { "src:points": { x: 48, y: 40 } };
    // The offer carries the spot explicitly, as `addSource` does.
    const after: LayoutSnapshot = { positions: { n1: { x: 0, y: 0 }, ...placements }, notes: [] };
    const delta = diffLayout(before, after);
    expect(delta).not.toBeNull();
    const step: LayoutStep = { kind: "layout", name: "source_placed", by: null, delta: delta!, label: words.sourcePlaced("points") };
    // Undo pressed at once: the screen the record reads is the tiles plus
    // the placement, and the step must take the source away rather than
    // find it already gone and drop itself.
    const screen: LayoutSnapshot = { positions: screenPositions([tile("n1", 0, 0)], placements), notes: [] };
    const inverse = layoutInverse(step, "undo", screen);
    expect(inverse).not.toBeNull();
    expect(inverse!.dropped).toEqual(["src:points"]);
    expect(inverse!.positions).toEqual({ n1: { x: 0, y: 0 } });
    expect(inverse!.leftOut).toEqual([]);
  });

  it("keeps the two placing rules it was extracted with", () => {
    expect(positionsOf([tile("n1", 8, 8), note("note:k", 0, 0)])).toEqual({ n1: { x: 8, y: 8 } });
    // A spot already taken steps right by a member's width and a gutter.
    expect(nudgeFree({ x: 0, y: 0 }, { n1: { x: 0, y: 0 } }, 200, 96)).toEqual({ x: 240, y: 0 });
    expect(nudgeFree({ x: 0, y: 0 }, { n1: { x: 400, y: 0 } }, 200, 96)).toEqual({ x: 0, y: 0 });
    // A paste steps down its diagonal while a member stands there.
    expect(nudgeDiagonal({ x: 0, y: 0 }, { n1: { x: 0, y: 0 } })).toEqual({ x: 24, y: 24 });
  });
});

/**
 * A placement the read has echoed is the tile's own from then on and is
 * forgotten; one still waiting for its read stays. Without the prune a
 * member removed by another tab or an agent kept its placement under
 * every later snapshot, a phantom the record and the layout write both
 * carried. Seen red against the absent rule (found at review).
 */
describe("the placements still waiting for their read", () => {
  it("forgets a placement the graph now holds and keeps one it does not, untouched when nothing is echoed", () => {
    const placements = { n1: { x: 48, y: 40 }, "src:points": { x: 96, y: 40 } };
    const held = (id: string) => id === "n1";
    expect(unechoedPlacements(placements, held)).toEqual({ "src:points": { x: 96, y: 40 } });
    // Nothing echoed: the same object, so the screen sets no state.
    expect(unechoedPlacements(placements, () => false)).toBe(placements);
  });

  it("leaves no phantom behind a member removed elsewhere after its read", () => {
    // The node was placed, its read echoed it (the tile stood), then
    // another tab removed it and the next read dropped the tile.
    const placements = { n1: { x: 48, y: 40 } };
    const afterEcho = unechoedPlacements(placements, (id) => id === "n1");
    expect(screenPositions([], afterEcho)).toEqual({});
    // Against the unpruned placements the phantom stands in every snapshot.
    expect(screenPositions([], placements)).toEqual({ n1: { x: 48, y: 40 } });
  });
});

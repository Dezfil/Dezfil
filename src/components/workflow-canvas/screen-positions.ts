import type { Positions } from "./arrange";
import { isMemberNode, type FlowNode } from "./to-flow";

/**
 * Where the members sit on the screen: the positions the record and every
 * layout write read off the canvas, and the two rules that place a member
 * among them. Pure; extracted from `WorkflowCanvas` PR round, where the
 * record read the tiles alone.
 *
 * A member takes its spot before any read has echoed it — a loose source
 * placed from the pane, a node added or brought back — and until that
 * read lands the spot lives only in the canvas's transient placements.
 * The screen shows the member all the same, so the record must see it
 * there: without it an undo taken in that window finds the member already
 * absent and drops its step ((d) and 3(f)).
 */

/** The members' positions; a note's travel with the note. */
export const positionsOf = (nodes: FlowNode[]): Positions =>
  Object.fromEntries(
    nodes.filter(isMemberNode).map((n) => [n.id, { x: n.position.x, y: n.position.y }]),
  );

/** Every member's position as the screen holds it: the tiles it shows,
 * over the placements no read has echoed yet. The tiles win, since a
 * placement is not forgotten when its read lands and the member may have
 * been moved since. `gone` is a member on its way off the canvas, left
 * out of both. */
export function screenPositions(nodes: FlowNode[], placements: Positions, gone?: string): Positions {
  const positions: Positions = { ...placements, ...positionsOf(nodes) };
  if (gone !== undefined) delete positions[gone];
  return positions;
}

/** The placements still waiting for their read. A placement the graph
 * now holds is the tile's own from then on and is forgotten; kept, it
 * outlived its member when another tab or an agent removed it, a phantom
 * every later snapshot carried and a layout undo wrote a position for
 * (found at review). The same object when nothing is
 * echoed, so the screen sets no state. */
export function unechoedPlacements(placements: Positions, held: (id: string) => boolean): Positions {
  const echoed = Object.keys(placements).filter(held);
  if (echoed.length === 0) return placements;
  const rest = { ...placements };
  for (const id of echoed) delete rest[id];
  return rest;
}

/** The first free spot at or right of `spot`: one that overlaps no
 * member's box, stepping by a member's width plus a gutter. */
export function nudgeFree(spot: Positions[string], taken: Positions, w: number, h: number): Positions[string] {
  const overlaps = (p: Positions[string]) =>
    Object.values(taken).some((q) => Math.abs(q.x - p.x) < w + 16 && Math.abs(q.y - p.y) < h + 16);
  let next = spot;
  for (let i = 0; i < 64 && overlaps(next); i += 1) next = { x: next.x + w + 40, y: next.y };
  return next;
}

/** The next free step down a paste's diagonal: 24 right and 24 down again
 * while a member already stands there. */
export function nudgeDiagonal(spot: Positions[string], taken: Positions): Positions[string] {
  const held = (p: Positions[string]) => Object.values(taken).some((q) => Math.abs(q.x - p.x) < 8 && Math.abs(q.y - p.y) < 8);
  let next = spot;
  for (let i = 0; i < 64 && held(next); i += 1) next = { x: next.x + 24, y: next.y + 24 };
  return next;
}

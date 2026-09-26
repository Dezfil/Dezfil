import { placeBeside, type Positions } from "./arrange";
import type { CanvasGraph } from "./graph";
import { initialPositions, type LayoutRead } from "./placement";
import { flowNodes, isMemberNode, isNoteNode, type FlowNode } from "./to-flow";

/**
 * The nodes for a changed graph: existing members keep their positions
 * and selection, new ones take the layout's place, the placement the
 * canvas gave them before any read, or a place beside the graph; gone
 * ones leave; the notes ride through unchanged. Pure; left
 * `WorkflowCanvas` at review, the file that round touched at this very
 * call.
 */
export function reconcileNodes(
  current: FlowNode[],
  graph: CanvasGraph,
  layout: LayoutRead,
  /** Where a member added from the pane was dropped, before the layout says. */
  placements: Positions,
  /** A member to select once it exists (a pasted node). */
  select: string | null = null,
): FlowNode[] | null {
  // The notes are the canvas's own: they ride through unchanged.
  const noteNodes = current.filter(isNoteNode);
  const members = current.filter(isMemberNode);
  const have = new Map(members.map((n) => [n.id, n]));
  const positions: Positions = Object.fromEntries(members.map((n) => [n.id, n.position]));
  const wanted = flowNodes(graph, initialPositions(graph, layout));
  const next = wanted.map((n) => {
    const existing = have.get(n.id);
    // The library's measured size rides along: a node rebuilt without it is
    // drawn hidden until re-measured, and its edges with it (the first
    // field run of: every edit's re-read emptied the canvas of edges).
    if (existing) return { ...n, position: existing.position, selected: select ? false : existing.selected, measured: existing.measured };
    const placed = placements[n.id];
    const fresh = { ...n, selected: select === n.id };
    if (placed) return { ...fresh, position: placed };
    const named = layout.updatedAt !== null && n.data.member.kind === "node" && layout.steps[n.id] !== undefined;
    return named ? fresh : { ...fresh, position: placeBeside(positions) };
  });
  const changed =
    next.length !== members.length ||
    next.some((n, i) => members[i]?.id !== n.id || have.get(n.id)?.data.member !== n.data.member) ||
    (select !== null && next.some((n) => n.id === select));
  return changed ? [...noteNodes, ...next] : null;
}


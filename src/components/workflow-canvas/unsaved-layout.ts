import type { LayoutRead } from "./placement";
import { isNoteNode, type FlowNode } from "./to-flow";

export function savedPosition(node: FlowNode, layout: LayoutRead) {
  if (isNoteNode(node)) return layout.notes.find(note => note.id === node.data.note.id);
  return node.data.member.kind === "source" ? layout.sources[node.data.member.name] : layout.steps[node.id];
}
export function markUnsavedNodes(nodes: FlowNode[], layout: LayoutRead | null): FlowNode[] {
  if (!layout) return nodes;
  return nodes.map(node => {
    const saved = savedPosition(node, layout);
    const unsavedPosition = !saved || saved.x !== node.position.x || saved.y !== node.position.y;
    if (isNoteNode(node)) {
      const before = layout.notes.find(note => note.id === node.data.note.id);
      return { ...node, data: { ...node.data, unsaved: JSON.stringify(before) !== JSON.stringify(node.data.note) } };
    }
    return { ...node, data: { ...node.data, unsavedPosition } } as FlowNode;
  });
}

/** An unwritten arrangement still has a visible accepted opening position. */
export function withOpeningPositions(layout: LayoutRead, opening: FlowNode[]): LayoutRead {
  const steps = { ...layout.steps }, sources = { ...layout.sources };
  for (const node of opening) {
    if (isNoteNode(node)) continue;
    if (node.data.member.kind === "source") sources[node.data.member.name] ??= node.position;
    else steps[node.id] ??= node.position;
  }
  return { ...layout, steps, sources };
}

import type { Edge, Node } from "@xyflow/react";
import type { CanvasEdge, CanvasGraph, NodeMember, SourceMember } from "./graph";
import type { Positions } from "./arrange";
import type { LayoutNote } from "./placement";
import { noteName } from "./note-text";

/**
 * The graph as the canvas library wants it: one node per member with its
 * position, one edge per canvas edge with the facts its presentation
 * composes. Nothing is connectable, deletable or reconnectable here: the
 * recipe is read, not edited. Members drag.
 */

export type BadgeFlowNode = Node<{ member: NodeMember }, "badge">;
export type SourceFlowNode = Node<{ member: SourceMember }, "source">;
/** A note: the layout's note, and whether it is open for editing. */
export type NoteFlowNode = Node<{ note: LayoutNote; editing: boolean; locked: boolean }, "note">;
export type MemberFlowNode = BadgeFlowNode | SourceFlowNode;
export type FlowNode = MemberFlowNode | NoteFlowNode;
export type ReadFlowEdge = Edge<{ edge: CanvasEdge; lifted?: boolean }, "read">;

/** A note's canvas identity, apart from every step's and source's. */
export const NOTE_PREFIX = "note:";
export const noteNodeId = (noteId: string) => `${NOTE_PREFIX}${noteId}`;
export const isNoteNode = (n: FlowNode): n is NoteFlowNode => n.type === "note";
export const isMemberNode = (n: FlowNode): n is MemberFlowNode => n.type !== "note";

/** The notes' layer, under manual stacking: below every member (0 and,
 * selected, 1000) and every edge (0), in the document's order among
 * themselves, whether selected or not. */
export const NOTE_Z = -2000;
/** The element that describes a note to assistive technology. */
export const NOTE_A11Y_ID = "note-a11y-description";

export function noteFlowNode(note: LayoutNote, editing: boolean, order: number, locked = false): NoteFlowNode {
  return {
    id: noteNodeId(note.id),
    type: "note",
    position: { x: note.x, y: note.y },
    width: note.w,
    height: note.h,
    data: { note, editing, locked },
    // Locked, nothing moves: the flag is per node, since a node's own
    // overrides the canvas's.
    draggable: !editing && !locked,
    selectable: true,
    connectable: false,
    deletable: false,
    zIndex: NOTE_Z + order,
    ariaLabel: noteName(note.text),
    // An annotation, never a node, to assistive technology:
    // the note role, its own description, its own role description.
    ariaRole: "note",
    domAttributes: { "aria-roledescription": "annotation", "aria-describedby": NOTE_A11Y_ID },
  };
}

/** The element id a node's disclosure carries, for `aria-describedby`. */
export const disclosureId = (nodeId: string) => `disclosure-${nodeId}`;

export const OUT_HANDLE = "out";
export const SQL_HANDLE = "sql";

/** The accessible name: operation, output and state. */
export function nodeName(m: NodeMember): string {
  return [m.label, m.outputName, m.state.word].filter(Boolean).join(", ");
}

export function sourceName(m: SourceMember): string {
  return `${m.name}, ${m.missing ? "missing table" : "source table"}`;
}

export function flowNodes(graph: CanvasGraph, positions: Positions, locked = false): MemberFlowNode[] {
  return graph.members.map((m) => {
    const position = positions[m.id] ?? { x: 0, y: 0 };
    // Locked, nothing moves or links: per node, since a node's own
    // flags override the canvas's.
    const base = { id: m.id, position, draggable: !locked, selectable: true, connectable: !locked, deletable: false };
    return m.kind === "node"
      ? ({
          ...base,
          type: "badge",
          data: { member: m },
          ariaLabel: nodeName(m),
          // Every condition true of it and its last successful run, as the
          // node's accessible description.
          domAttributes: { "aria-describedby": disclosureId(m.id) },
        } satisfies BadgeFlowNode)
      : ({ ...base, type: "source", data: { member: m }, ariaLabel: sourceName(m) } satisfies SourceFlowNode);
  });
}

export function flowEdges(graph: CanvasGraph, selected: string | null = null, locked = false): ReadFlowEdge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    type: "read",
    source: e.from,
    sourceHandle: OUT_HANDLE,
    target: e.to,
    targetHandle: e.attachment.kind === "port" ? e.attachment.port : SQL_HANDLE,
    // A selected member lifts its edges with it.
    data: { edge: e, lifted: selected !== null && (e.from === selected || e.to === selected) },
    focusable: false,
    selectable: false,
    deletable: false,
    // A filled input's link can be dragged off its port to move or detach
    // it; the SQL node's and a lineage edge cannot.
    reconnectable: !locked && e.attachment.kind === "port" && e.time !== "lineage" ? "target" : false,
  }));
}

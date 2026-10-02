"use client";
import type { ComponentProps, ReactNode } from "react";
import { ReactFlow, type ReactFlowProps } from "@xyflow/react";
import { BadgeNode } from "./BadgeNode";
import { SourceNode } from "./SourceNode";
import { NoteNode } from "./NoteNode";
import { ConnectionLine, ReadEdge } from "./ReadEdge";
import { NoteActionsContext } from "./note-actions";
import { CanvasGrid } from "./CanvasGrid";
import { CanvasSaveStatus } from "./CanvasSaveStatus";
import type { Whisper } from "./save-whisper";
import { GRID } from "./arrange";
import type { FlowNode, ReadFlowEdge } from "./to-flow";
import { MAX_ZOOM, MIN_ZOOM, fitOptions } from "./view";
import styles from "./WorkflowCanvas.module.css";

const NODE_TYPES = { badge: BadgeNode, source: SourceNode, note: NoteNode };
const EDGE_TYPES = { read: ReadEdge };
const ARIA = {
  "node.a11yDescription.default":
    "Press Enter or Space to select. The arrow keys move a selected node; Escape clears the selection.",
  "node.a11yDescription.keyboardDisabled": "Press Enter or Space to select.",
  "node.a11yDescription.ariaLiveMessage": ({
    direction,
    x,
    y,
  }: {
    direction: string;
    x: number;
    y: number;
  }) => `Moved ${direction} to ${Math.round(x)}, ${Math.round(y)}.`,
  "edge.a11yDescription.default": "",
  "handle.ariaLabel": "Port",
} as const;

type Props = ReactFlowProps<FlowNode, ReadFlowEdge> & {
  view: "full" | "framed"; panel: boolean; reserve: number; helperRight: number;
  locked: boolean; noteMode: boolean;
  noteActions: ComponentProps<typeof NoteActionsContext.Provider>["value"];
  whisper: Whisper | null; children: ReactNode;
};

/** Stage and node presentation, separate from editor ordering and history. */
export function WorkflowStage({ view, panel, reserve, helperRight, locked, noteMode, noteActions, whisper, children, ...flowProps }: Props) {
  return <>
    <NoteActionsContext.Provider value={noteActions}>
        <ReactFlow<FlowNode, ReadFlowEdge>
          {...flowProps}
          className={styles.flow}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          connectionLineComponent={ConnectionLine}
          fitView
          fitViewOptions={fitOptions(view, panel, reserve, helperRight)}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          snapToGrid
          snapGrid={[GRID, GRID]}
          nodesDraggable={!locked}
          nodesConnectable={!locked}
          edgesFocusable={false}
          edgesReconnectable={!locked}
          connectionRadius={24}
          reconnectRadius={24}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionOnDrag={false}
          panOnDrag={!noteMode}
          zIndexMode="manual"
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={ARIA}
          aria-label="Workflow canvas"
        >
          <CanvasGrid />
        </ReactFlow>
        </NoteActionsContext.Provider>
    {children}
    <CanvasSaveStatus whisper={whisper} />
  </>;
}

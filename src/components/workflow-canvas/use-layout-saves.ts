"use client";

import { useEffect, useMemo } from "react";
import type { WorkflowDocument } from "./workflow-document";
import type { CanvasGraph } from "./graph";
import { LayoutSaveCoordinator, type LayoutSaves, type SaveState } from "./layout-save-coordinator";
import type { LayoutRead } from "./placement";

export type { LayoutSnapshot, LayoutSaves, SaveState } from "./layout-save-coordinator";

/** React ownership and live-port adapter for the plain layout coordinator. */
export function useLayoutSaves({
  document,
  id,  layout,
  graph,
  onState,
  onWritten,
  lockReason,
  say,
}: {
  document?: WorkflowDocument;
  id: string;
  /** The last successfully read (or written) document. */
  layout: LayoutRead;
  graph: CanvasGraph;
  onState: (state: SaveState) => void;
  /** The document as stored after a write; the screen keeps it live. */
  onWritten?: (layout: LayoutRead) => void;
  /** The canvas lock and notice are read only when Retry acts. */
  lockReason: () => string | null;
  say: (text: string, tone?: "bad") => void;
}): LayoutSaves {
  const coordinator = useMemo(
    () => new LayoutSaveCoordinator(id, layout, { graph, onState, onWritten, lockReason, say }, document),
    [id, document], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    coordinator.setLayout(layout);
  }, [coordinator, layout]);
  useEffect(() => {
    coordinator.setPorts({ graph, onState, onWritten, lockReason, say });
  }, [coordinator, graph, lockReason, onState, onWritten, say]);
  return coordinator;
}

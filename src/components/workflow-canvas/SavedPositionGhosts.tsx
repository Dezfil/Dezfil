"use client";
import { ViewportPortal } from "@xyflow/react";
import type { LayoutRead } from "./placement";
import { isNoteNode, type FlowNode } from "./to-flow";
import { savedPosition } from "./unsaved-layout";
import styles from "./SavedPositionGhosts.module.css";

export function SavedPositionGhosts({ nodes, layout }: { nodes: FlowNode[]; layout: LayoutRead | null }) {
  if (!layout) return null;
  return <ViewportPortal>{nodes.map(node => {
    if (isNoteNode(node) || !node.data.unsavedPosition) return null;
    const position = savedPosition(node, layout);
    return position ? <span key={node.id} className={styles.ghost} data-saved-position={node.id}
      aria-hidden style={{ left: position.x + 36, top: position.y }} /> : null;
  })}</ViewportPortal>;
}

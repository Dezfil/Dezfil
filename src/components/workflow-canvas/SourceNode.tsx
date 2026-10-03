"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { formatCount } from "../api";
import { geometryGlyphType } from "../geometry-class";
import { GeometryGlyph } from "../ui/operation-icons";
import type { SourceFlowNode } from "./to-flow";
import { OUT_HANDLE } from "./to-flow";
import { NODE_W } from "./arrange";
import { UnsavedMark } from "../builder/UnsavedFields";
import styles from "./WorkflowCanvas.module.css";

/**
 * A source tile (reference 12's source form): the table's geometry-kind
 * icon on a plain tile, its name and its row count under it, or "missing"
 * with a dashed frame when the table does not exist; an output port on the
 * right. Sources are derived, never edited.
 */

const BOX = { x: 36, y: 0, w: 72, h: 72 };
/** From the node's right, for the library's right-side rule (see BadgeNode). */
const OUT_RIGHT = NODE_W - (BOX.x + BOX.w);

export function SourceNode({ data, selected, dragging, isConnectable }: NodeProps<SourceFlowNode>) {
  const m = data.member;
  return (
    <div
      className={styles.member}
      data-node
      data-name={m.name}
      data-kind="source"
      data-missing={m.missing || undefined}
      data-loose={m.loose || undefined}
      data-lineage={m.lineageOnly || undefined}
      data-sel={selected || undefined}
      data-drag={dragging || undefined}
    >
      <span className={`${styles.tBox} ${styles.src}`} data-v="badge" style={{ left: BOX.x, top: BOX.y, width: BOX.w, height: BOX.h }}>
        <span className={styles.tIcon} data-kind={m.table?.geometryColumn ? "spatial" : "none"}>
          <GeometryGlyph geometryType={geometryGlyphType(m.table)} />
        </span>
      </span>
      <span className={styles.tLabel} style={{ top: BOX.y + BOX.h + 7 }}>
        <span className={styles.srcName}>{m.name}</span>
        <span className={styles.tOut}>{m.missing ? "missing" : m.table ? `${formatCount(m.table.rowCount)} rows` : ""}</span>
        {data.unsavedPosition && <UnsavedMark>unsaved position</UnsavedMark>}
      </span>
      <Handle
        type="source"
        id={OUT_HANDLE}
        position={Position.Right}
        isConnectable={!m.missing && isConnectable}
        className={styles.port}
        data-out
        data-off={m.missing || undefined}
        style={{ right: OUT_RIGHT, top: BOX.y + BOX.h / 2 }}
        aria-label={`Output of ${m.name}`}
      />
    </div>
  );
}

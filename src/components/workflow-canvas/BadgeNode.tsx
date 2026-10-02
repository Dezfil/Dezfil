"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CheckIcon, PencilIcon, RerunIcon, WarnIcon } from "../ui/icons";
import { OperationGlyph } from "../ui/operation-icons";
import type { BadgeFlowNode } from "./to-flow";
import { SQL_HANDLE, OUT_HANDLE, disclosureId } from "./to-flow";
import { NODE_W } from "./arrange";
import { UnsavedMark } from "../builder/UnsavedFields";
import styles from "./WorkflowCanvas.module.css";

/**
 * The Badge tile (reference 12): the operation's glyph on a tile in its
 * group's hue, the state as a corner badge, the operation's name and the
 * output's name under it; input ports on the left for a named-input node,
 * one silent side for the SQL node; the output port on the right. The
 * disclosure — every condition true of it and its last successful run —
 * shows on hover and on keyboard focus, and stays in the accessible tree.
 * Ports say what they are and do nothing.
 */

const BOX = { x: 36, y: 0, w: 72, h: 72 };
const PORT_STEP = 16;
/** The output port is placed from the node's right, as the library's
 * right-side rule expects (it centres the handle on that edge); a left
 * offset there landed the port a handle's width outside the tile (the).
 * */
const OUT_RIGHT = NODE_W - (BOX.x + BOX.w);

function portTop(index: number, count: number): number {
  const mid = BOX.y + BOX.h / 2;
  return mid + (index - (count - 1) / 2) * PORT_STEP;
}

function Badge({ glyph }: { glyph: "spinner" | "warn" | "rerun" | "edit" | "check" | null }) {
  if (!glyph) return null;
  return (
    <span className={styles.tBadge} data-s={glyph} aria-hidden="true">
      {glyph === "spinner" ? <span className={styles.spin} /> : null}
      {glyph === "warn" ? <WarnIcon /> : null}
      {glyph === "rerun" ? <RerunIcon /> : null}
      {glyph === "edit" ? <PencilIcon /> : null}
      {glyph === "check" ? <CheckIcon /> : null}
    </span>
  );
}

export function BadgeNode({ data, selected, dragging, isConnectable }: NodeProps<BadgeFlowNode>) {
  const m = data.member;
  const ports = m.ports;
  return (
    <div
      className={styles.member}
      data-node
      data-name={m.outputName || undefined}
      data-kind="node"
      data-state={m.state.word}
      data-tone={m.state.tone}
      data-grp={m.group ?? undefined}
      data-sel={selected || undefined}
      data-drag={dragging || undefined}
    >
      <span className={styles.tBox} data-v="badge" style={{ left: BOX.x, top: BOX.y, width: BOX.w, height: BOX.h }}>
        <span className={styles.tIcon}>
          <OperationGlyph symbol={m.symbol} />
        </span>
        <Badge glyph={m.state.badge} />
        {m.state.word === "running" ? (
          <svg className={styles.ring} viewBox={`0 0 ${BOX.w + 3} ${BOX.h + 3}`} aria-hidden="true">
            <rect className={styles.ringTrack} x="1.6" y="1.6" width={BOX.w - 0.2} height={BOX.h - 0.2} rx="18.5" />
            <rect className={styles.ringComet} x="1.6" y="1.6" width={BOX.w - 0.2} height={BOX.h - 0.2} rx="18.5" pathLength={100} />
          </svg>
        ) : null}
      </span>
      <span className={styles.tLabel} style={{ top: BOX.y + BOX.h + 7 }}>
        <b className={styles.tName}>{m.label}</b>
        <span className={styles.tOut}>{m.outputName}</span>
        {data.unsavedPosition && <UnsavedMark>unsaved position</UnsavedMark>}
      </span>
      <span id={disclosureId(m.id)} className={styles.disclosure} data-disclosure>
        {m.disclosure}
      </span>
      {m.sql ? (
        <Handle
          type="target"
          id={SQL_HANDLE}
          position={Position.Left}
          isConnectable={false}
          className={styles.sqlSide}
          style={{ left: BOX.x, top: BOX.y + BOX.h / 2 }}
          aria-label="Reads what its query names"
        />
      ) : (
        ports.map((p, i) => (
          <Handle
            key={p.name}
            type="target"
            id={p.name}
            position={Position.Left}
            isConnectable={isConnectable}
            className={styles.port}
            data-on={p.value !== null || undefined}
            style={{ left: BOX.x, top: portTop(i, ports.length) }}
            aria-label={p.value ? `${p.label}: ${p.value}` : `${p.label}: not set`}
          >
            <i className={styles.pLabel} aria-hidden="true">
              {p.label}
              {p.value ? ` · ${p.value}` : ""}
            </i>
          </Handle>
        ))
      )}
      <Handle
        type="source"
        id={OUT_HANDLE}
        position={Position.Right}
        isConnectable={isConnectable}
        className={styles.port}
        data-out
        style={{ right: OUT_RIGHT, top: BOX.y + BOX.h / 2 }}
        aria-label="Output"
      />
    </div>
  );
}

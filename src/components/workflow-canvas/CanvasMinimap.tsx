"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNodes, useReactFlow, useStore, useViewport } from "@xyflow/react";
import { NODE_H, NODE_W } from "./arrange";
import type { CanvasEdge } from "./graph";
import { isMemberNode, isNoteNode, type FlowNode } from "./to-flow";
import styles from "./WorkflowCanvas.module.css";

/**
 * The minimap: the workflow's own, not the library's — every node and
 * source as a small rect in its state's colour, every present edge as a
 * line, and the viewport as a frame; it appears at six visible members and
 * moves the view when clicked or dragged. Notes are drawn as tinted boxes
 * behind the members and join the extent. Whether it shows is the canvas's
 * decision (six members, or the viewer's choice by the stage button); when
 * rendered it draws, whatever the count.
 */

const W = 180;
const H = 112;
const PAD = 30;

export function CanvasMinimap({ edges }: { edges: CanvasEdge[] }) {
  const nodes = useNodes<FlowNode>();
  const { x: tx, y: ty, zoom } = useViewport();
  const flow = useReactFlow();
  const size = useStore((s) => ({ w: s.width, h: s.height }));
  const [dragging, setDragging] = useState(false);
  const ref = useRef<SVGSVGElement>(null);

  // Notes join the extent and are drawn behind the members.
  const shownNodes = nodes.filter((n) => !n.hidden);
  const visible = shownNodes.filter(isMemberNode);
  const noteNodes = shownNodes.filter(isNoteNode);

  // The graph's bounds, notes included, and the scale that fits them.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of visible) {
    x0 = Math.min(x0, n.position.x);
    y0 = Math.min(y0, n.position.y);
    x1 = Math.max(x1, n.position.x + (n.measured?.width ?? NODE_W));
    y1 = Math.max(y1, n.position.y + (n.measured?.height ?? NODE_H));
  }
  for (const n of noteNodes) {
    x0 = Math.min(x0, n.position.x);
    y0 = Math.min(y0, n.position.y);
    x1 = Math.max(x1, n.position.x + (n.measured?.width ?? n.data.note.w));
    y1 = Math.max(y1, n.position.y + (n.measured?.height ?? n.data.note.h));
  }
  if (!Number.isFinite(x0)) {
    x0 = 0; y0 = 0; x1 = 600; y1 = 400;
  }
  const k = Math.min((W - 12) / (x1 - x0 + PAD * 2), (H - 12) / (y1 - y0 + PAD * 2));
  const ox = 6 - (x0 - PAD) * k;
  const oy = 6 - (y0 - PAD) * k;
  const at = new Map(visible.map((n) => [n.id, n]));

  // A point on the map, in canvas units.
  const toCanvas = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return null;
      const mx = ((e.clientX - r.left) / r.width) * W;
      const my = ((e.clientY - r.top) / r.height) * H;
      return { x: (mx - ox) / k, y: (my - oy) / k };
    },
    [k, ox, oy],
  );
  const centreOn = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const p = toCanvas(e);
      if (p) void flow.setCenter(p.x, p.y, { zoom, duration: 0 });
    },
    [flow, toCanvas, zoom],
  );
  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragging]);

  const vx = -tx / zoom, vy = -ty / zoom, vw = size.w / zoom, vh = size.h / zoom;
  return (
    <svg
      ref={ref}
      className={styles.minimap}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Minimap: the whole workflow and the part in view"
      data-minimap
      onPointerDown={(e) => {
        setDragging(true);
        centreOn(e);
      }}
      onPointerMove={(e) => {
        if (dragging) centreOn(e);
      }}
    >
      {noteNodes.map((n) => (
        <rect
          key={n.id}
          className={styles.mmNote}
          data-c={n.data.note.color}
          x={ox + n.position.x * k}
          y={oy + n.position.y * k}
          width={Math.max(3, (n.measured?.width ?? n.data.note.w) * k)}
          height={Math.max(2, (n.measured?.height ?? n.data.note.h) * k)}
          rx={1.5}
        />
      ))}
      {edges
        .filter((e) => e.time !== "lineage")
        .map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const aw = a.measured?.width ?? NODE_W, ah = a.measured?.height ?? NODE_H;
          const bh = b.measured?.height ?? NODE_H;
          return (
            <line
              key={e.id}
              className={styles.mmEdge}
              x1={ox + (a.position.x + aw) * k}
              y1={oy + (a.position.y + ah / 2) * k}
              x2={ox + b.position.x * k}
              y2={oy + (b.position.y + bh / 2) * k}
            />
          );
        })}
      {visible.map((n) => {
        const m = n.data.member;
        const state = m.kind === "node" ? m.state.word : m.missing ? "cannot run" : "source";
        return (
          <rect
            key={n.id}
            className={styles.mmNode}
            data-s={state}
            data-sel={n.selected || undefined}
            x={ox + n.position.x * k}
            y={oy + n.position.y * k}
            width={Math.max(3, (n.measured?.width ?? NODE_W) * k)}
            height={Math.max(2, (n.measured?.height ?? NODE_H) * k)}
            rx={1.5}
          />
        );
      })}
      <rect className={styles.mmView} x={ox + vx * k} y={oy + vy * k} width={vw * k} height={vh * k} rx={2} />
    </svg>
  );
}

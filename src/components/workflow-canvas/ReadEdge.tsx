"use client";

import { BaseEdge, EdgeLabelRenderer, type ConnectionLineComponentProps, type EdgeProps } from "@xyflow/react";
import type { ReadFlowEdge } from "./to-flow";
import styles from "./WorkflowCanvas.module.css";

/**
 * The reference's curve (reference 13): a cubic from the output port to
 * the input port with horizontal tangents of 45% of the horizontal run,
 * never shorter than 40, so a short edge still leaves and lands level and
 * a long one bows gently; its word sits at the chord's middle.
 */
export function referenceCurve(sx: number, sy: number, tx: number, ty: number) {
  const dx = Math.max(40, Math.abs(tx - sx) * 0.45);
  return {
    path: `M${sx} ${sy} C${sx + dx} ${sy} ${tx - dx} ${ty} ${tx} ${ty}`,
    labelX: (sx + tx) / 2,
    labelY: (sy + ty) / 2,
  };
}

/**
 * A read edge: the reference's curve from the producer's
 * output port to the reader's port or side, with an arrowhead (10 by 11,
 * darker than the line), presented by three independent facts —
 * attachment (port or the SQL node's side), time (present, proposed,
 * lineage) and condition (broken, stale) — as reference 12's edge kinds.
 * Proposed and built-from carry their word.
 */
/**
 * The library ends an edge at the port box's outer edge, and the box (18)
 * is wider than the circle drawn in it (9, border-box), so the line used to
 * stop short of both circles by 4.5px. It now runs from beside the source
 * circle to beside the target circle, the arrowhead's tip a hair off the
 * circle (on, -08-29: "the tip a little to the right, closer to the
 * circle"; the 3px is their own hand's setting, tried against 4.5). The SQL
 * node's silent side has no circle, so a read that lands there keeps the
 * library's point.
 *
 * The line ends inside the arrowhead, not at its tip: at the tip the head
 * has narrowed to a point while the stroke is still 1.8 wide, so the last
 * pixels of the line showed beside it: zoomed in, the straight line
 * behind the head reads longer than the tip. Four pixels in, the
 * head is wider than the stroke and its round cap alike.
 */
const PORT_INSET = 3;
const HEAD_LENGTH = 10;
const LINE_INTO_HEAD = 4;

export function ReadEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<ReadFlowEdge>) {
  const e = data?.edge;
  const sx = sourceX - PORT_INSET;
  const tx = e?.attachment.kind === "sql" ? targetX : targetX + PORT_INSET;
  const { path, labelX, labelY } = referenceCurve(sx, sourceY, tx - LINE_INTO_HEAD, targetY);
  const word = e?.time === "proposed" ? "proposed" : e?.time === "lineage" ? "built from" : null;
  return (
    <g
      className={styles.edge}
      data-sql={e?.attachment.kind === "sql" || undefined}
      data-time={e?.time}
      data-broken={e?.broken || undefined}
      data-stale={e?.stale || undefined}
      data-lifted={data?.lifted || undefined}
    >
      <BaseEdge id={id} path={path} className={styles.link} interactionWidth={0} />
      <polygon className={styles.arrow} points={`${tx - HEAD_LENGTH},${targetY - 5.5} ${tx - HEAD_LENGTH},${targetY + 5.5} ${tx},${targetY}`} />
      {word ? (
        <EdgeLabelRenderer>
          <span
            className={styles.edgeWord}
            data-time={e?.time}
            style={{ transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 4}px)` }}
          >
            {word}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}

/** The link being made (reference 12's pending link), on the same curve. */
export function ConnectionLine({ fromX, fromY, toX, toY }: ConnectionLineComponentProps) {
  return <path className={styles.pending} d={referenceCurve(fromX, fromY, toX, toY).path} />;
}

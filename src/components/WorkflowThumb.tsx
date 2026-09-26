import { workflowGraph } from "./workflow-graph";
import type { WorkflowStep } from "./workflow-model";

/**
 * A workflow's own graph as its thumbnail: sources and nodes by dependency,
 * nodes in their operation group's hue, edges from present reads. Drawn
 * from the API's facts; a rendering, never a rule.
 */
export function WorkflowThumb({
  steps,
  groupOf,
  compact = false,
}: {
  steps: WorkflowStep[];
  /** Operation id → catalog group, for the hue; unknown reads as the accent. */
  groupOf: (operation: string) => string | null;
  compact?: boolean;
}) {
  const W = compact ? 96 : 280;
  const H = compact ? 60 : 92;
  const g = workflowGraph(steps);
  const pad = compact ? 6 : 14;
  const bw = compact ? 14 : 30;
  const bh = compact ? 9 : 18;
  const colW = g.cols > 0 ? (W - pad * 2) / g.cols : 0;
  const rowsIn = new Map<number, number>();
  for (const n of g.nodes) rowsIn.set(n.col, (rowsIn.get(n.col) ?? 0) + 1);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of g.nodes) {
    const count = rowsIn.get(n.col) ?? 1;
    const x = pad + colW * n.col + colW / 2 - bw / 2;
    const y = pad + ((n.row + 0.5) * (H - pad * 2)) / count - bh / 2;
    pos.set(n.id, { x, y });
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {g.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + bw, y1 = a.y + bh / 2, x2 = b.x, y2 = b.y + bh / 2;
        const dx = Math.max(6, (x2 - x1) * 0.5);
        return (
          <path
            key={i}
            d={`M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={compact ? 1 : 1.4}
          />
        );
      })}
      {g.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const group = n.operation ? groupOf(n.operation) : null;
        return (
          <rect
            key={n.id}
            x={p.x}
            y={p.y}
            width={bw}
            height={bh}
            rx={compact ? 2.5 : 5}
            data-kind={n.kind}
            data-grp={group ?? undefined}
            fill={n.kind === "source" ? "var(--fg-faint)" : `var(--grp-${(group ?? "").toLowerCase()}, var(--accent))`}
            fillOpacity={n.kind === "source" ? 0.55 : n.condition === "never_run" ? 0.38 : 0.9}
          />
        );
      })}
    </svg>
  );
}

"use client";

import {
  setDrawSelection,
  useDrawMode,
  type DrawSelection,
} from "./draw-mode";
import styles from "./draw.module.css";

/**
 * The instruction pill: bottom centre, naming the armed tool and its
 * gestures and the running session's contents, absent when it has
 * nothing to say. While a drawn shape is selected the same slot
 * identifies it and offers its delete. Visual reference:
 */

const TOOL_COPY: Record<string, [string, string, string?]> = {
  hand: ["Hand", "Drag to move the map · scroll to zoom"],
  select: ["Select", "Click a drawn shape · ⌫ deletes it"],
  point: ["Point", "Click to drop points · each click saves a feature"],
  line: [
    "Line",
    "Click to place vertices · double-click or Enter finishes",
    "⌫ removes the last",
  ],
  polygon: [
    "Polygon",
    "Click to place vertices · close on the first vertex or double-click",
    "⌫ removes the last",
  ],
  rectangle: ["Rectangle", "Drag corner to corner"],
  circle: [
    "Circle",
    "Drag out from the centre · the radius reads in ground metres",
  ],
  freehand: ["Freehand", "Press and drag · release closes the shape"],
};

const KIND_NAMES: Record<string, string> = {
  point: "Point",
  line: "Line",
  polygon: "Polygon",
  rectangle: "Rectangle",
  circle: "Circle",
  freehand: "Freehand shape",
};

export function DrawPill({
  committedCount,
  layerName,
  onDeleteSelected,
}: {
  committedCount: number;
  layerName: string | null;
  onDeleteSelected: (selection: DrawSelection) => void;
}) {
  const mode = useDrawMode();
  if (mode.selected && (!mode.open || mode.tool === "select" || !mode.tool)) {
    const sel = mode.selected;
    const name = KIND_NAMES[sel.kind] ?? "Shape";
    const movable = sel.kind === "polygon" || sel.kind === "freehand";
    return (
      <div className={styles.pill} role="status">
        <b>{name}</b>
        <span>
          {movable ? "drag a handle to move a vertex" : "selected"}
        </span>
        <button
          type="button"
          className={styles.pillDelete}
          onClick={() => onDeleteSelected(sel)}
        >
          Delete
        </button>
        <span className={styles.pillFaint}>or press ⌫</span>
        <button
          type="button"
          className={styles.pillDelete}
          style={{ color: "var(--fg-faint)" }}
          onClick={() => setDrawSelection(null)}
        >
          Done
        </button>
      </div>
    );
  }
  if (!mode.open) return null;
  if (mode.tool) {
    const [name, gesture, extra] = TOOL_COPY[mode.tool];
    return (
      <div className={styles.pill} role="status">
        <b>{name}</b>
        <span>{gesture}</span>
        {extra && <span className={styles.pillFaint}>{extra}</span>}
      </div>
    );
  }
  return (
    <div className={styles.pill} role="status">
      <b>Draw</b>
      {committedCount > 0 && layerName ? (
        <span>
          {layerName} · {committedCount}{" "}
          {committedCount === 1 ? "shape" : "shapes"} · pick a tool to keep
          drawing
        </span>
      ) : (
        <span>Pick a tool. This session&rsquo;s shapes become one layer</span>
      )}
      <span className={styles.pillFaint}>Esc closes</span>
    </div>
  );
}

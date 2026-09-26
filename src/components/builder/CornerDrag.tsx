"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { Corner } from "@/lib/corners";
import styles from "./CornerDrag.module.css";

/** Movement (px) below which a press stays a click — clicks edit, drags move. */
const DRAG_THRESHOLD = 5;

function quadrantOf(x: number, y: number, rect: DOMRect): Corner {
  const v = y < rect.top + rect.height / 2 ? "top" : "bottom";
  const h = x < rect.left + rect.width / 2 ? "left" : "right";
  return `${v}-${h}` as Corner;
}

/**
 * Drag an overlay to a corner: press-and-move past a threshold lifts the
 * box, it follows the pointer, and the corner of the quadrant under the
 * pointer is previewed; release drops it there — a drop is exactly a
 * corner pick, free positioning does not exist. Escape cancels. A plain
 * click (no movement) passes through untouched, so click-to-edit keeps
 * working; presses on links and controls never start a drag.
 */
export function CornerDrag({
  corner,
  onPreview,
  onDrop,
  children,
}: {
  corner: Corner;
  /** The corner the drop would land in (null when the drag ends). */
  onPreview: (target: Corner | null) => void;
  onDrop: (target: Corner) => void;
  children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const suppressClick = useRef(false);
  const teardown = useRef<(() => void) | null>(null);

  // Unmount mid-drag: drop the window listeners.
  useEffect(() => () => teardown.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || teardown.current) return;
    // Links and controls keep their own behavior — no drag from them.
    if (
      (e.target as HTMLElement).closest("a, button, input, textarea, select")
    ) {
      return;
    }
    const startX = e.clientX;
    const startY = e.clientY;
    const canvasEl = el.current?.closest("[data-drag-canvas]") as
      | HTMLElement
      | null;
    const canvas = canvasEl?.getBoundingClientRect() ?? null;
    // Pointer movement arrives in screen pixels; the translation is
    // applied in the canvas's own layout pixels. Those are the same
    // number everywhere the builder uses this — but not inside the
    // export card's preview, which lays its composition out at the
    // author's chosen size and displays it scaled. Dividing by the
    // canvas's own display factor is the identity in every other host,
    // and stops the overlay lagging the pointer in that one.
    const displayFactor =
      canvasEl && canvas && canvasEl.offsetWidth > 0
        ? canvas.width / canvasEl.offsetWidth
        : 1;
    let dragging = false;
    let target: Corner | null = null;

    const move = (ev: PointerEvent) => {
      const screenX = ev.clientX - startX;
      const screenY = ev.clientY - startY;
      if (!dragging) {
        // The threshold stays in screen pixels: it is about the user's
        // hand, not about the canvas's scale.
        if (Math.hypot(screenX, screenY) < DRAG_THRESHOLD) return;
        dragging = true;
        suppressClick.current = true; // the release must not read as a click
      }
      ev.preventDefault();
      setDrag({ dx: screenX / displayFactor, dy: screenY / displayFactor });
      const next = canvas ? quadrantOf(ev.clientX, ev.clientY, canvas) : null;
      if (next !== target) {
        target = next;
        onPreview(next);
      }
    };
    const finish = (commit: boolean) => {
      teardown.current?.();
      teardown.current = null;
      setDrag(null);
      onPreview(null);
      if (commit && dragging && target && target !== corner) onDrop(target);
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    teardown.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={el}
      className={styles.wrap}
      data-dragging={drag !== null}
      style={
        drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined
      }
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
    >
      {/* Grip handle: appears on hover — "this moves". */}
      <div className={styles.handle} aria-hidden />
      {children}
    </div>
  );
}

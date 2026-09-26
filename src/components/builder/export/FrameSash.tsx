"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { clampAspect } from "./aspect";
import styles from "./ExportImageCard.module.css";

/**
 * A custom-shape handle (field rounds): an edge sash, rendered
 * only while Custom is the chosen shape — one on the bottom edge, one on
 * the right (the second added when it was asked for).
 *
 * Each sash drags its own edge, and the shape's ratio falls out of where
 * the edge lands. The exported pixel width still belongs to the Size
 * control — the sashes change the *shape*; a wider frame is a wider
 * ratio, not more pixels.
 *
 * The ratio is computed in display space from the frame's live geometry
 * each move (the drag itself reshapes the frame, so a rect captured at
 * pointer-down would go stale by the second event), and the release
 * reports the last ratio the drag reached — never state, which a listener
 * installed at pointer-down would have closed over from the render it was
 * born in (the review's finding, kept fixed here).
 */
export function FrameSash({
  edge,
  onRatio,
  onEnd,
}: {
  edge: "bottom" | "right";
  onRatio: (ratio: number) => void;
  /** The drag finished, with the ratio it ended on (null = never moved). */
  onEnd: (ratio: number | null) => void;
}) {
  const sashRef = useRef<HTMLButtonElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const frame = sashRef.current?.parentElement;
    if (!frame) return;
    e.preventDefault();
    // The frame is CENTERED in its stage on both axes, so its top and
    // left move as it grows — a size measured from a moving edge applied
    // only part of each pointer step and the sash trailed the drag. The centre is the geometry's
    // fixed point:
    // the dragged edge sits at centre + size/2, so putting it under the
    // pointer means size = 2 × (pointer − centre), anchored once at grab.
    const start = frame.getBoundingClientRect();
    const center =
      edge === "bottom"
        ? start.top + start.height / 2
        : start.left + start.width / 2;
    let latest: number | null = null;
    const move = (ev: PointerEvent) => {
      if (edge === "bottom") {
        const height = 2 * (ev.clientY - center);
        if (height < 24) return;
        const width = frame.getBoundingClientRect().width;
        latest = clampAspect(width / height);
      } else {
        const width = 2 * (ev.clientX - center);
        if (width < 24) return;
        const height = frame.getBoundingClientRect().height;
        latest = clampAspect(width / height);
      }
      onRatio(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <button
      ref={sashRef}
      type="button"
      className={styles.frameSash}
      data-edge={edge}
      aria-label={
        // The bottom sash keeps its name — the shape journey selects by
        // it, and the two must stay distinguishable anyway.
        edge === "bottom"
          ? "Drag to change the image's shape"
          : "Drag sideways to change the image's shape"
      }
      title={
        edge === "bottom"
          ? "Drag up or down for any shape"
          : "Drag left or right for any shape"
      }
      onPointerDown={onPointerDown}
    >
      <span className={styles.frameSashGrip} aria-hidden />
    </button>
  );
}

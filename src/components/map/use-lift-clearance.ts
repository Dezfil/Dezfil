"use client";

import { useEffect, useState } from "react";

/** Daylight required between the docked timeline and a corner stack
 * before the corner may stay grounded instead of lifting above the bar.
 * Deliberately generous: a collision detected mid-resize can only start
 * the lift after geometry has already moved, so the
 * margin makes the lift begin while daylight remains at human resize
 * and legend-growth speeds. Full pre-emption would require predicting
 * future geometry; the margin plus the fast enter-glide bound the
 * transient instead. */
const CLEARANCE_GAP = 28;

/** Whether two horizontal extents collide, with the clearance margin. */
export function horizontalCollision(
  a: { left: number; right: number },
  b: { left: number; right: number },
  gap: number = CLEARANCE_GAP,
): boolean {
  return a.left < b.right + gap && b.left < a.right + gap;
}

/** A landed measurement, keyed to the exact pair it measured — a new
 * dock or corner element renders lifted until its own first frame. */
type Measured = {
  dock: HTMLElement;
  corner: HTMLElement;
  lift: boolean;
};

/** True while `corner` must lift above the docked timeline: the dock is
 * mounted and the two horizontal extents would collide in the bottom
 * band. The bar is bottom-centered and width-capped, so a wide canvas
 * leaves the corner's column free — the lift applied regardless, which
 * a field round flagged; this makes the lift
 * geometry-driven. Vertical positions never enter the measurement, so
 * lifting cannot feed back into its own trigger. An unmeasured pair is
 * always lifted — the arrangement that cannot overlap — so a newly
 * docked timeline never flashes through a grounded corner while its
 * first measurement waits for the frame.
 */
export function useLiftClearance(
  dock: HTMLElement | null,
  corner: HTMLElement | null,
): boolean {
  const [measured, setMeasured] = useState<Measured | null>(null);

  useEffect(() => {
    if (!dock || !corner) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setMeasured({
        dock,
        corner,
        lift: horizontalCollision(
          dock.getBoundingClientRect(),
          corner.getBoundingClientRect(),
        ),
      });
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    queue();
    const ro = new ResizeObserver(queue);
    ro.observe(dock);
    ro.observe(corner);
    // The dock is centered in its host, so the host resizing (panel
    // collapse, fullscreen) moves the dock without resizing it.
    if (dock.parentElement) ro.observe(dock.parentElement);
    window.addEventListener("resize", queue);
    // The dock's `left` glides on fullscreen toggles; re-measure at the
    // settled position rather than mid-flight.
    const host = dock.parentElement ?? dock;
    host.addEventListener("transitionend", queue, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", queue);
      host.removeEventListener("transitionend", queue, true);
    };
  }, [dock, corner]);

  if (!dock || !corner) return dock !== null;
  return measured && measured.dock === dock && measured.corner === corner
    ? measured.lift
    : true;
}

"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/**
 * A panel anchored to its trigger, placed in viewport coordinates: the
 * results card clips its overflow, so a panel positioned inside it would
 * be cut off whenever the card is short — the editor divider can leave it
 * at its 160px minimum. Fixed positioning from the trigger's rectangle
 * escapes the clip without a portal; the panel opens below, right-aligned
 * to the trigger, and flips above when the viewport has no room below.
 * Re-placed when the panel's own size changes (the stored-as hint, an
 * error) and on resize — the kit Menu's rule.
 */
export function useAnchored(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  gap = 6,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!rect || !panel) return;
    const { width, height } = panel.getBoundingClientRect();
    const below = rect.bottom + gap;
    const fitsBelow = below + height <= window.innerHeight - 8;
    const top = fitsBelow ? below : Math.max(8, rect.top - gap - height);
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPos({ top, left });
  }, [triggerRef, panelRef, gap]);

  // A stale position from the last opening is never painted: the layout
  // effect places the panel before the browser paints the new opening.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined")
      return () => window.removeEventListener("resize", place);
    const ro = new ResizeObserver(place);
    ro.observe(panel);
    return () => {
      window.removeEventListener("resize", place);
      ro.disconnect();
    };
  }, [open, place, panelRef]);

  return pos;
}

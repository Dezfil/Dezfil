"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useHeaderMin } from "./header-min";
import { affordableReach, applyYield, measureRow, rowItems } from "./affordable-reach";

/**
 * The shell's header card: sized by its content, as before,
 * but never narrower than the reach a surface contributes — its left
 * pane's right edge — so the two stack aligned. The card measures its
 * own left edge rather than assuming the gutter, and the reach is
 * clamped to what the row can afford: the actions beside the card do not
 * shrink, so the floor gives way before they would leave the viewport,
 * re-measured as the row, its items and their contents change. A sibling
 * that yields (the builder's search field) narrows for the reach first,
 * by no more than the card needs.
 */
export function HeadCard({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const paneRight = useHeaderMin();
  const ref = useRef<HTMLDivElement>(null);
  const [minWidth, setMinWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    if (paneRight === null || !card) {
      if (card) applyYield(card, null, null);
      setMinWidth(null);
      return;
    }
    const measure = () => {
      const row = measureRow(card);
      const reach = row ? affordableReach(paneRight, row) : null;
      applyYield(card, row, reach);
      setMinWidth(reach);
    };
    measure();
    const row = card.parentElement;
    if (!row || typeof ResizeObserver === "undefined") return;
    // Sizes: the row (a narrower window), and every other item (labels
    // that hide at a width, a status text that grows). Items portaled in
    // later are picked up by the mutation observer's rescan.
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(row);
      for (const item of rowItems(row)) if (item !== card) sizes.observe(item);
    };
    watch();
    const contents =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
        watch();
        measure();
      });
    contents?.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      sizes.disconnect();
      contents?.disconnect();
      applyYield(card, null, null);
    };
  }, [paneRight]);
  return (
    <div
      ref={ref}
      className={className}
      style={minWidth !== null ? { minWidth } : undefined}
    >
      {children}
    </div>
  );
}

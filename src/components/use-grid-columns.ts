"use client";

import { useEffect, useState } from "react";

/**
 * How many columns a grid renders: a workflow folder's pane sits at the
 * end of the folder's row, so the page needs the count the grid's
 * auto-fill template resolved to, re-read when the grid resizes. Before
 * the first measurement the count is null and the pane sits right after
 * the folder. The element comes in as state, not a ref, so a grid that
 * remounts (the catalog re-entering its pending state under an open
 * folder) is observed afresh rather than its detached node.
 */
export function useGridColumns(el: HTMLElement | null, active: boolean): number | null {
  const [columns, setColumns] = useState<number | null>(null);
  useEffect(() => {
    if (!active || !el) return;
    const read = () => {
      const template = getComputedStyle(el).gridTemplateColumns;
      const count = template.split(" ").filter((part) => part.length > 0).length;
      setColumns(count > 0 ? count : 1);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, active]);
  return active ? columns : null;
}

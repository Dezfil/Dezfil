"use client";

import { useCallback, useEffect } from "react";
import { canvasTakesSelectAll, clearStraySelection } from "./page-selection";

/**
 * The canvas's hold on the page's text selection: while the workflow
 * canvas is mounted, Cmd/Ctrl+A with the canvas owning the key selects
 * nothing, and the handler this returns, on the flow area's capture
 * phase, clears a selection swept elsewhere on the page when the canvas
 * is pressed. The rules live in page-selection.ts; this is their
 * wiring.
 */
export function usePageSelection(): (e: React.PointerEvent) => void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (canvasTakesSelectAll(e)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return useCallback((e: React.PointerEvent) => {
    clearStraySelection(e.target);
  }, []);
}

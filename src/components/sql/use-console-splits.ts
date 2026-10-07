"use client";

import { useCallback, useEffect, useState } from "react";
import { HELPER_OFFSET } from "../builder/helper-bands";
import { SQL_KEYS, readStored, writeStored } from "./sql-storage";
import { readRailShift } from "../rail-mode";

/**
 * The console's remembered sizes and their splits (extracted from
 * `SqlConsole.tsx` by, which adds the docked bound): the Tables and
 * History pane's width and the editor's height, hydrated once on the
 * client, reclamped to the viewport, dragged by the two handles and
 * written on release.
 *
 * The sidebar's bound is half of what is available to it. While the
 * assistant pane is docked (answer to its) that width is what the pane
 * leaves: the viewport less the rail, the docked pane with its gutter
 * and the screen's right gutter. A remembered width above that bound
 * narrows for the pane's duration, comes back when the pane closes, and
 * the remembered preference is never rewritten by the clamp.
 */
export const PANE_MIN = 260;
const PANE_MAX_FRACTION = 0.5;
const EDITOR_MIN = 120;
const RESULTS_MIN = 160;
/** The rail (82) and the screen's right gutter (14). */
const RAIL_PX = 82;
const RIGHT_GUTTER_PX = 14;

/** The width available to the sidebar: the window, less what a docked
 * assistant pane takes with its gutter and the chrome around it, the
 * always-open rail's extra width (`railShift`) included. */
export function sidebarAvailable(innerWidth: number, paneDocked: boolean, railShift = 0): number {
  return paneDocked ? innerWidth - RAIL_PX - railShift - HELPER_OFFSET - RIGHT_GUTTER_PX : innerWidth;
}

/** The sidebar's bound: half of what is available to it, never under its minimum. */
export function sidebarBound(innerWidth: number, paneDocked: boolean, railShift = 0): number {
  return Math.max(PANE_MIN, Math.floor(sidebarAvailable(innerWidth, paneDocked, railShift) * PANE_MAX_FRACTION));
}

/** The width the sidebar shows: the remembered width, clamped for the
 * docked pane's duration and otherwise itself. */
export function shownSidebarWidth(remembered: number, innerWidth: number, paneDocked: boolean, railShift = 0): number {
  return Math.min(remembered, sidebarBound(innerWidth, paneDocked, railShift));
}

function clampPane(px: number): number {
  return Math.min(sidebarBound(window.innerWidth, false), Math.max(PANE_MIN, Math.round(px)));
}
function clampEditor(px: number): number {
  const workHeight = window.innerHeight - 62 - 14;
  const max = Math.max(EDITOR_MIN, workHeight - RESULTS_MIN - 14);
  return Math.min(max, Math.max(EDITOR_MIN, Math.round(px)));
}

export function useConsoleSplits(paneDocked: boolean) {
  const [paneWidth, setPaneWidth] = useState(342);
  const [editorHeight, setEditorHeight] = useState(260);
  const [innerWidth, setInnerWidth] = useState(1440);
  // What the always-open rail takes beside the pane, read with the window
  // after hydration so the first render matches the server's.
  const [railShift, setRailShift] = useState(0);

  /** The remembered sizes, once, client-only: the caller gates on hydration. */
  const hydrate = useCallback(() => {
    const pw = readStored<number | null>(SQL_KEYS.paneWidth, null);
    if (typeof pw === "number") setPaneWidth(clampPane(pw));
    const eh = readStored<number | null>(SQL_KEYS.editorHeight, null);
    setEditorHeight(clampEditor(typeof eh === "number" ? eh : (window.innerHeight - 76) * 0.36));
    setInnerWidth(window.innerWidth);
    setRailShift(readRailShift());
  }, []);

  // Reclamp the remembered sizes when the viewport changes.
  useEffect(() => {
    const onResize = () => {
      setPaneWidth((w) => clampPane(w));
      setEditorHeight((h) => clampEditor(h));
      setInnerWidth(window.innerWidth);
      setRailShift(readRailShift());
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = useCallback(
    (axis: "x" | "y", e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      // A drag starts from the width shown, so a clamped sidebar is not
      // yanked to its remembered width at the first pixel of the drag.
      const startW = shownSidebarWidth(paneWidth, window.innerWidth, paneDocked, readRailShift());
      const startH = editorHeight;
      handle.setAttribute("data-drag", "");
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      const move = (ev: MouseEvent) => {
        if (axis === "x") setPaneWidth(Math.min(sidebarBound(window.innerWidth, paneDocked, readRailShift()), clampPane(startW + ev.clientX - startX)));
        else setEditorHeight(clampEditor(startH + ev.clientY - startY));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        handle.removeAttribute("data-drag");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setPaneWidth((w) => {
          writeStored(SQL_KEYS.paneWidth, w);
          return w;
        });
        setEditorHeight((h) => {
          writeStored(SQL_KEYS.editorHeight, h);
          return h;
        });
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [paneWidth, editorHeight, paneDocked],
  );

  return {
    /** The width the sidebar shows now. */
    paneWidth: shownSidebarWidth(paneWidth, innerWidth, paneDocked, railShift),
    editorHeight,
    hydrate,
    startDrag,
  };
}

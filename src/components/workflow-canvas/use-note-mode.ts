"use client";

import { useCallback, useRef, useState } from "react";
import { rectAt, rectFromDrag, type Rect } from "./note-geometry";

/**
 * Note mode: on after the tool or *N*, off after one note, on Escape, or
 * on the tool again. While on, a press on the canvas's background starts
 * a drag that draws a ghost; letting go places a note of the dragged
 * size, or of the default size centred on the point when the pointer
 * barely moved. The rects are the flow's; the barely moved question is
 * the screen's, so the answer does not change with the zoom (found at
 * review). Pure state; the canvas wires the pane.
 */

const CLICK_TOLERANCE = 4;

type Point = { x: number; y: number };
const past = (a: Point, b: Point) => Math.abs(b.x - a.x) >= CLICK_TOLERANCE || Math.abs(b.y - a.y) >= CLICK_TOLERANCE;

export function useNoteMode() {
  const [on, setOn] = useState(false);
  const [ghost, setGhost] = useState<Rect | null>(null);
  const start = useRef<{ flow: Point; client: Point } | null>(null);

  const begin = useCallback((flow: Point, client: Point) => {
    start.current = { flow, client };
    setGhost(null);
  }, []);

  const move = useCallback((flow: Point, client: Point) => {
    const s = start.current;
    if (!s || !past(s.client, client)) return;
    setGhost(rectFromDrag(s.flow, flow));
  }, []);

  /** The note's rect for where the press ended, or null without a press. */
  const end = useCallback((flow: Point, client: Point): Rect | null => {
    const s = start.current;
    start.current = null;
    setGhost(null);
    if (!s) return null;
    return past(s.client, client) ? rectFromDrag(s.flow, flow) : rectAt(flow);
  }, []);

  const cancel = useCallback(() => {
    start.current = null;
    setGhost(null);
    setOn(false);
  }, []);

  return { on, setOn, ghost, begin, move, end, cancel };
}

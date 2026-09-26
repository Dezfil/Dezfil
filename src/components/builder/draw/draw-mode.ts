"use client";

import { useSyncExternalStore } from "react";
import {
  armedPickLabel,
  disarmPick,
  onPickArmed,
} from "../drawer/pick-mode";

/**
 * The draw-mode store — the pick-mode pattern: a module store, because
 * the dock that arms a tool, the overlay that draws, the pill that
 * explains and the canvas that yields clicks are sibling trees. One
 * publisher, many readers.
 *
 * The store owns the mode — dock open, armed tool, selection — and the
 * two keyboard contracts:
 *
 * - **Escape unwinds one level per press**: uncommitted
 *   draft, then armed tool, then the dock. The draft lives in the
 *   overlay, which registers its cancel here so the ladder stays one
 *   handler. Registered in the CAPTURE phase — the house pattern, with
 *   pick-mode's recorded reason — and yielding to an armed pick-mode,
 *   whose own capture-phase Escape owns that press.
 * - **The session owns undo while the dock is open**: the
 *   chord is consumed in the capture phase before the builder's
 *   bubble-phase history binding can see it, and the session's handler
 *   removes the latest committed shape. Text editing keeps native undo.
 *
 * Mutual exclusion with the Tools picker's Select mode is
 * wired at the two arm sites: arming a draw tool disarms pick-mode, and
 * pick-mode's arm observer disarms the tool here.
 */

export type DrawTool =
  | "hand"
  | "select"
  | "point"
  | "line"
  | "polygon"
  | "rectangle"
  | "circle"
  | "freehand";

/** The six shape tools — the ones that own the pointer while armed. */
export const SHAPE_TOOLS: readonly DrawTool[] = [
  "point",
  "line",
  "polygon",
  "rectangle",
  "circle",
  "freehand",
];

export interface DrawSelection {
  layerId: string;
  table: string;
  featureId: string;
  kind: string;
}

export interface DrawModeState {
  /** Dock open = a session is running (its dataset mints on first commit). */
  open: boolean;
  tool: DrawTool | null;
  selected: DrawSelection | null;
}

let state: DrawModeState = { open: false, tool: null, selected: null };
const listeners = new Set<() => void>();

/** The overlay's draft cancel; true = a draft consumed the Escape. */
let cancelDraft: (() => boolean) | null = null;
/** The session's undo; called while the dock is open. */
let undoHandler: (() => void) | null = null;
/** The session's close — announces and clears the session. */
let closeHandler: (() => void) | null = null;

export function registerDraftCancel(fn: (() => boolean) | null): void {
  cancelDraft = fn;
}
export function registerDrawUndo(fn: (() => void) | null): void {
  undoHandler = fn;
}
export function registerDrawClose(fn: (() => void) | null): void {
  closeHandler = fn;
}

function publish(next: DrawModeState) {
  const wasBound = state.open || state.selected !== null;
  state = next;
  const bound = state.open || state.selected !== null;
  if (bound && !wasBound)
    window.addEventListener("keydown", onKeydown, { capture: true });
  if (!bound && wasBound)
    window.removeEventListener("keydown", onKeydown, { capture: true });
  for (const l of listeners) l();
}

function inTextEditing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  return (
    t instanceof HTMLInputElement &&
    ["text", "search", "number", "email", "url", "password"].includes(t.type)
  );
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (e.defaultPrevented) return;
    // An armed pick-mode owns this press — its own capture handler
    // disarms; the next press reaches this ladder.
    if (armedPickLabel() !== null) return;
    e.preventDefault();
    e.stopPropagation();
    if (cancelDraft?.()) return;
    if (state.tool) {
      publish({ ...state, tool: null });
      return;
    }
    if (state.open) {
      closeDraw();
      return;
    }
    if (state.selected) publish({ ...state, selected: null });
    return;
  }
  // The session owns undo while the dock is open — the
  // chord never reaches map history, even when nothing is committed yet.
  if (
    state.open &&
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === "z"
  ) {
    if (e.repeat || inTextEditing(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    undoHandler?.();
  }
}

export function openDraw(): void {
  if (state.open) return;
  publish({ open: true, tool: null, selected: null });
}

export function closeDraw(): void {
  if (!state.open) return;
  publish({ open: false, tool: null, selected: null });
  closeHandler?.();
}

/** Silent reset for leaving a map: no close announcement —
 * the session hook being torn down is the same instance that would have
 * announced, and the next map must start clean. */
export function resetDraw(): void {
  if (!state.open && state.tool === null && state.selected === null) return;
  publish({ open: false, tool: null, selected: null });
}

/** Arm a tool; arming the armed one disarms it (the prototype's toggle). */
export function armDrawTool(tool: DrawTool): void {
  if (!state.open) return;
  disarmPick();
  publish({
    ...state,
    tool: state.tool === tool ? null : tool,
    selected: null,
  });
}

export function setDrawSelection(selected: DrawSelection | null): void {
  publish({ ...state, selected });
}

export function drawState(): DrawModeState {
  return state;
}

const read = () => state;
// One frozen object — a fresh literal per call trips React's
// getServerSnapshot caching warning (surfaced by the browser round).
const SERVER_STATE: DrawModeState = { open: false, tool: null, selected: null };
const readServer = (): DrawModeState => SERVER_STATE;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useDrawMode(): DrawModeState {
  return useSyncExternalStore(subscribe, read, readServer);
}

// Arming the Tools picker's Select disarms an armed draw tool — the
// other half of the rule's exclusivity.
onPickArmed(() => {
  if (state.tool !== null) publish({ ...state, tool: null });
});

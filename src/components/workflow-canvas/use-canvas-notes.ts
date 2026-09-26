"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeChange } from "@xyflow/react";
import type { NoteColor } from "@/lib/metadata/recipe-layouts";
import type { LayoutName } from "./canvas-history";
import type { NoteActions } from "./note-actions";
import { centreOf, duplicateRect, NOTE_COLOR_NAMES, rectAt, settleResize, snap, type Rect } from "./note-geometry";
import { NEW_NOTE_TEXT } from "./note-text";
import type { LayoutNote, LayoutRead } from "./placement";
import { isMemberNode, isNoteNode, NOTE_PREFIX, noteFlowNode, noteNodeId, type FlowNode, type NoteFlowNode } from "./to-flow";
import { useNoteMode } from "./use-note-mode";
import { FAR_ZOOM } from "./view";

/**
 * The notes coordinator, beside the canvas: the live list as the layout
 * document holds it, in its order, seeded from the read and re-seeded
 * only when a read brings a different document (our own write's echo is
 * the same); the note open for editing; note mode with its ghost; the
 * limit; every mutation, each offering the newest whole snapshot through
 * the canvas's one writer; the library's changes to a note's position,
 * settled on the grid; the keys and the pane gesture; the focus after an
 * edit, a duplicate and a removal. The canvas only composes what this
 * hands it. Nothing here touches the recipe.
 */

export const NOTES_MAX = 100;
export const NOTE_MODE_NOTICE = "Click or drag on the canvas to place a note, or press Enter for the centre. Esc cancels.";
export const NOTE_TOOL_LIMIT = "this workflow holds a hundred notes already";

const same = (a: LayoutNote[], b: LayoutNote[]) => JSON.stringify(a) === JSON.stringify(b);
const newId = () => `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A member lifts when selected (the library's own elevation, kept by
 * hand under manual stacking); a note never leaves its layer. */
const MEMBER_Z = 0;
const MEMBER_SELECTED_Z = 1000;

interface Flow {
  getZoom: () => number;
  setCenter: (x: number, y: number, o: { zoom?: number; duration?: number }) => Promise<boolean> | void;
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
}

export function useCanvasNotes({
  layout,
  flow,
  write,
  say,
  hush,
  deselect,
  focusCanvas,
  focusTool,
  focusNote,
  freeRect,
  writesPending,
  lockReason = null,
}: {
  layout: LayoutRead;
  flow: Flow;
  /** Write the notes as they are now, with the members' positions; the
   * name is the step the change makes. */
  write: (notes: LayoutNote[], name: LayoutName) => void;
  say: (text: string, tone?: "bad", hold?: boolean) => void;
  hush: () => void;
  deselect: () => void;
  focusCanvas: () => void;
  focusTool: () => void;
  focusNote: (id: string) => void;
  /** The drawable canvas, in screen coordinates, or null. */
  freeRect: () => { left: number; top: number; right: number; bottom: number } | null;
  /** Whether a layout write is on the wire or waiting. */
  writesPending: () => boolean;
  /** The canvas lock's reason while it is locked: every note edit is refused with it. */
  lockReason?: string | null;
}) {
  const [notes, setNotes] = useState<LayoutNote[]>(layout.notes);
  const [editingId, setEditingId] = useState<string | null>(null);
  const notesRef = useRef(notes);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  const [seenLayout, setSeenLayout] = useState(layout);
  if (seenLayout !== layout) {
    setSeenLayout(layout);
    // While our own writes are on the wire, an arriving document may be an
    // older write's echo: quick changes must never be rolled back by it
    // (found at review). Once the wire is quiet, the last echo equals the
    // local state, and a genuinely newer read reseeds as before.
    if (!writesPending() && !same(layout.notes, notes)) setNotes(layout.notes);
  }
  // A note just made or duplicated is selected once its node exists.
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const update = useCallback(
    (next: LayoutNote[], name: LayoutName) => {
      notesRef.current = next;
      setNotes(next);
      write(next, name);
    },
    [write],
  );
  /** The notes a step of the record puts back:
   * the screen takes them, and nothing is recorded or written — the
   * record offers the one write of the whole snapshot itself. */
  const apply = useCallback((list: LayoutNote[]) => {
    notesRef.current = list;
    setNotes(list);
  }, []);
  const canAdd = useCallback(() => notesRef.current.length < NOTES_MAX, []);

  // ---- note mode ----
  const mode = useNoteMode();
  const placeNote = useCallback(
    (rect: Rect) => {
      mode.setOn(false);
      hush();
      if (lockReason) return;
      if (!canAdd()) return;
      const id = newId();
      const note: LayoutNote = { id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: "yellow", text: NEW_NOTE_TEXT };
      update([...notesRef.current, note], "note_placed");
      setEditingId(id);
      setPendingSelect(noteNodeId(id));
    },
    [canAdd, hush, lockReason, mode, update],
  );
  const toggleMode = useCallback(() => {
    if (mode.on) {
      mode.cancel();
      hush();
      return;
    }
    if (lockReason) {
      say(lockReason, "bad");
      return;
    }
    if (!canAdd()) return;
    deselect();
    mode.setOn(true);
    say(NOTE_MODE_NOTICE, undefined, true);
    focusCanvas();
  }, [canAdd, deselect, focusCanvas, hush, lockReason, mode, say]);
  const leaveMode = useCallback(() => {
    mode.cancel();
    hush();
    focusTool();
  }, [focusTool, hush, mode]);
  const placeAtCentre = useCallback(() => {
    const r = freeRect();
    if (!r) return;
    const centre = flow.screenToFlowPosition(centreOf({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }));
    placeNote(rectAt(centre));
  }, [flow, freeRect, placeNote]);
  const flowPoint = useCallback((e: { clientX: number; clientY: number }) => flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), [flow]);
  const pane = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!mode.on || e.button !== 0) return;
        if (!(e.target as HTMLElement).classList?.contains("react-flow__pane")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        mode.begin(flowPoint(e), { x: e.clientX, y: e.clientY });
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (mode.on) mode.move(flowPoint(e), { x: e.clientX, y: e.clientY });
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!mode.on) return;
        const rect = mode.end(flowPoint(e), { x: e.clientX, y: e.clientY });
        if (rect) placeNote(rect);
      },
    }),
    [flowPoint, mode, placeNote],
  );

  // ---- the actions a note asks for ----
  const bringNear = useCallback(
    (id: string) => {
      const note = notesRef.current.find((n) => n.id === id);
      if (!note || flow.getZoom() >= FAR_ZOOM) return;
      void flow.setCenter(note.x + note.w / 2, note.y + note.h / 2, { zoom: FAR_ZOOM, duration: 0 });
    },
    [flow],
  );
  // Locked, every edit a note asks for is refused with the reason.
  const refused = useCallback(() => {
    if (!lockReason) return false;
    say(lockReason, "bad");
    return true;
  }, [lockReason, say]);
  const actions = useMemo<NoteActions>(
    () => ({
      edit: (id) => {
        if (refused()) return;
        bringNear(id);
        setEditingId(id);
      },
      commit: (id, text, closedBy) => {
        setEditingId((e) => (e === id ? null : e));
        if (closedBy === "key") window.setTimeout(() => focusNote(id), 0);
        const current = notesRef.current;
        const note = current.find((n) => n.id === id);
        // An unchanged text makes no write at all.
        if (!note || note.text === text) return;
        update(current.map((n) => (n.id === id ? { ...n, text } : n)), "note_edited");
      },
      recolour: (id, color: NoteColor) => {
        if (refused()) return;
        if (!NOTE_COLOR_NAMES.includes(color)) return;
        update(notesRef.current.map((n) => (n.id === id ? { ...n, color } : n)), "note_recoloured");
      },
      duplicate: (id) => {
        if (refused()) return;
        if (!canAdd()) return;
        const note = notesRef.current.find((n) => n.id === id);
        if (!note) return;
        const rect = duplicateRect(note);
        const copy = newId();
        update([...notesRef.current, { ...note, id: copy, x: rect.x, y: rect.y }], "note_duplicated");
        setPendingSelect(noteNodeId(copy));
        window.setTimeout(() => focusNote(copy), 40);
      },
      remove: (id) => {
        if (refused()) return;
        setEditingId((e) => (e === id ? null : e));
        update(notesRef.current.filter((n) => n.id !== id), "note_removed");
        say("Note removed.");
        focusCanvas();
      },
      resized: (id, rect) => {
        if (refused()) return;
        const note = notesRef.current.find((n) => n.id === id);
        if (!note) return;
        const settled = settleResize(rect, { x: note.x, y: note.y, w: note.w, h: note.h });
        update(notesRef.current.map((n) => (n.id === id ? { ...n, ...settled } : n)), "note_resized");
      },
      canAdd,
    }),
    [bringNear, canAdd, focusCanvas, focusNote, refused, say, update],
  );

  /** A note from the clipboard: Duplicate's offset
   * from the copied note or the last paste of it on this canvas, else the
   * free view's centre; last in the order and selected. */
  const pasteNote = useCallback(
    (item: { text: string; color: NoteColor; w: number; h: number }, chain: { from: string | null; pasted: Set<string>; last: string | null; key: string | null }) => {
      if (refused()) return;
      if (!canAdd()) {
        say(`Not pasted: ${NOTE_TOOL_LIMIT}.`, "bad");
        return;
      }
      const here = (nodeId: string | null) => (nodeId ? (notesRef.current.find((n) => noteNodeId(n.id) === nodeId) ?? null) : null);
      const anchor = [...chain.pasted].reverse().map(here).find((n) => n !== null) ?? here(chain.from);
      let rect: Rect;
      if (anchor) {
        rect = duplicateRect({ x: anchor.x, y: anchor.y, w: item.w, h: item.h });
        // A spot another note already holds: the next step along the offset.
        const held = (r: Rect) => notesRef.current.some((n) => n.x === r.x && n.y === r.y);
        for (let i = 0; i < 64 && held(rect); i += 1) rect = duplicateRect(rect);
      } else {
        const r = freeRect();
        const centre = r ? flow.screenToFlowPosition(centreOf({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top })) : { x: 0, y: 0 };
        rect = { ...rectAt(centre), w: item.w, h: item.h };
      }
      const id = newId();
      update([...notesRef.current, { id, x: rect.x, y: rect.y, w: item.w, h: item.h, color: item.color, text: item.text }], "note_pasted");
      chain.pasted.add(noteNodeId(id));
      setPendingSelect(noteNodeId(id));
      say("Pasted the note.");
    },
    [canAdd, flow, freeRect, refused, say, update],
  );

  // ---- the library's changes: a completed move writes; a resize is the
  // note's own at its end (the transient dimensions stay the library's) ----
  const applyChange = useCallback(
    (change: NodeChange<FlowNode>): boolean => {
      if (!("id" in change) || !change.id.startsWith(NOTE_PREFIX)) return false;
      const id = change.id.slice(NOTE_PREFIX.length);
      if (change.type === "position" && change.dragging === false && change.position) {
        const x = snap(change.position.x);
        const y = snap(change.position.y);
        const note = notesRef.current.find((n) => n.id === id);
        if (note && (note.x !== x || note.y !== y)) update(notesRef.current.map((n) => (n.id === id ? { ...n, x, y } : n)), "note_moved");
      }
      return true;
    },
    [update],
  );

  // ---- the keys, routed at the canvas: whether each was a note's ----
  const keys = useMemo(
    () => ({
      /** Escape: note mode leaves first; a selected note is cleared by the
       * canvas's own clearing, which follows. */
      onEscape: (): boolean => {
        if (!mode.on) return false;
        leaveMode();
        return true;
      },
      onKey: (e: KeyboardEvent, target: HTMLElement | null, selected: FlowNode | undefined): boolean => {
        if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (!target?.closest("[data-flow-area], [data-canvas-stage]")) return false;
          if (document.querySelector("[data-dialog-host] [role='dialog']")) return false;
          e.preventDefault();
          toggleMode();
          return true;
        }
        if (e.key === "Enter" && mode.on) {
          // Enter on a control in mode still belongs to the control (the
          // tool's Enter toggles the tool); only elsewhere does it place.
          if (target?.closest("a, button, input, textarea, select, summary")) return false;
          e.preventDefault();
          placeAtCentre();
          return true;
        }
        if (!selected || !isNoteNode(selected)) return false;
        const id = selected.data.note.id;
        if (e.key === "Enter" && !selected.data.editing) {
          // The host hears the key before the library's wrapper does, and
          // Enter belongs to whatever holds focus: a menu button or a
          // link activates, another wrapper is the library's to select
          // (found at review). Only on the selected note's own wrapper, off
          // any interactive element within it, is Enter the edit key.
          if (target?.closest<HTMLElement>(".react-flow__node")?.dataset.id !== selected.id) return false;
          if (target?.closest("a, button, input, textarea, select, summary")) return false;
          e.preventDefault();
          e.stopPropagation();
          actions.edit(id);
          return true;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          actions.remove(id);
          return true;
        }
        return false;
      },
    }),
    [actions, leaveMode, mode, placeAtCentre, toggleMode],
  );

  // ---- the notes as the library wants them, merged with the members ----
  const withNotes = useCallback(
    (current: FlowNode[]): FlowNode[] => {
      const have = new Map(current.filter(isNoteNode).map((n) => [n.id, n]));
      const noteNodes: NoteFlowNode[] = notes.map((note, order) => {
        const wanted = noteFlowNode(note, editingId === note.id, order, lockReason !== null);
        const existing = have.get(wanted.id);
        if (!existing) return wanted;
        const moved = existing.data.note.x !== note.x || existing.data.note.y !== note.y;
        const sized = existing.data.note.w !== note.w || existing.data.note.h !== note.h;
        return {
          ...wanted,
          position: moved ? wanted.position : existing.position,
          width: sized ? wanted.width : existing.width,
          height: sized ? wanted.height : existing.height,
          selected: existing.selected,
          measured: sized ? undefined : existing.measured,
        };
      });
      const members = current.filter(isMemberNode);
      const merged: FlowNode[] = [...noteNodes, ...members];
      return pendingSelect ? merged.map((n) => ({ ...n, selected: n.id === pendingSelect })) : merged;
    },
    [notes, editingId, lockReason, pendingSelect],
  );
  /** The canvas says the merge applied the pending selection. */
  const consumeSelection = useCallback(() => setPendingSelect(null), []);

  /** Every member's stacking, kept by hand under manual stacking: a
   * selected member lifts, as the library would lift it. */
  const elevated = useCallback(
    (list: FlowNode[]): FlowNode[] => list.map((n) => (isMemberNode(n) ? { ...n, zIndex: n.selected ? MEMBER_SELECTED_Z : MEMBER_Z } : n)),
    [],
  );

  return {
    notes,
    editingId,
    apply,
    canAdd,
    mode: { on: mode.on, ghost: mode.ghost, toggle: toggleMode },
    actions,
    applyChange,
    withNotes,
    pendingSelect,
    consumeSelection,
    elevated,
    pane,
    pasteNote,
    keys,
  };
}

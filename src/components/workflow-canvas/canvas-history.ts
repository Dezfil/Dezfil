import type { Position, Positions } from "./arrange";
import type { LayoutNote } from "./placement";
import type { LayoutSnapshot } from "./use-layout-saves";

/**
 * The canvas's record of its own steps: the steps made on this page in
 * the order made, the undone ones on their own side, the newest hundred
 * kept, a fresh step forgetting the undone. A layout step holds only what
 * it changed, on both sides: the members it moved, placed or removed and
 * the notes it touched with their place in the order. A recipe step holds
 * only what its inverse needs, and the last success of every node it
 * names, the watermark a run's settle reads against. The rules that shape
 * steps live here too: a run of arrow keys on one member merges until a
 * boundary, a field's accepted edits merge while they share a node and a
 * focus session, an edit whose sides are equal and a discard that dropped
 * nothing are no step. It answers without applying: the next step on
 * either side, a step taken or dropped, a member's steps settled by a
 * run, every step re-keyed when a node comes back under a fresh identity,
 * and the words the notice uses. Pure: no React, no request, nothing of
 * the page.
 */

export const HISTORY_LIMIT = 100;

export type Direction = "undo" | "redo";

/** A node's definition on one side of a step: its active parameters and
 * its proposal, since which of the two comes back depends on whether the
 * node has run. */
export interface Definition {
  parameters: Record<string, unknown>;
  proposedParameters: Record<string, unknown> | null;
}

export type LayoutName =
  | "move"
  | "arrange"
  | "source_placed"
  | "source_removed"
  | "note_placed"
  | "note_moved"
  | "note_resized"
  | "note_recoloured"
  | "note_edited"
  | "note_duplicated"
  | "note_removed"
  | "note_pasted";

/** A member's position on both sides; null on the side it is not there. */
export interface MemberChange {
  id: string;
  before: Position | null;
  after: Position | null;
}
/** A note on both sides with its place in the order; null where absent. */
export interface NoteChange {
  id: string;
  before: { index: number; note: LayoutNote } | null;
  after: { index: number; note: LayoutNote } | null;
}
export interface LayoutDelta {
  members: MemberChange[];
  notes: NoteChange[];
}

export interface LayoutStep {
  kind: "layout";
  /** What the offer named itself: the words and the view rule follow it. */
  name: LayoutName;
  /** A completed move's origin: a drag is one step; key presses merge. */
  by: "drag" | "key" | null;
  delta: LayoutDelta;
  label: string;
}

export type RecipeOp =
  | { kind: "add"; operation: string; parameters: Record<string, unknown>; position: Position | null; pasted: boolean }
  | { kind: "edit"; before: Definition; after: Definition; session: string | null }
  | { kind: "discard"; before: Definition; after: Definition }
  | {
      kind: "relink";
      /** The reader that lost the link: put back first, undone. */
      holder: { nodeId: string; before: Definition; after: Definition };
      /** The reader that took it: detached second, undone. */
      taker: { nodeId: string; before: Definition; after: Definition };
    }
  | {
      kind: "remove";
      operation: string;
      /** The definition as the panel showed it, its name and named inputs among it. */
      parameters: Record<string, unknown>;
      position: Position | null;
      ordinal: number;
      dataset: "exists" | "deleted" | "never" | null;
    };

export interface RecipeStep {
  kind: "recipe";
  /** The node the step is keyed on: the one added, edited, removed, or the link's taker. */
  nodeId: string;
  /** The last success of every node the step names, as it stood when the
   * step was made: the run boundary reads against it. */
  watermarks: Record<string, string | null>;
  op: RecipeOp;
  label: string;
}

export type Step = LayoutStep | RecipeStep;

export interface History {
  past: Step[];
  future: Step[];
  /** A boundary since the newest step: the next step merges with nothing. */
  sealed: boolean;
}

export const EMPTY_HISTORY: History = { past: [], future: [], sealed: false };

// ---- the words ----

export const NOTHING_TO_UNDO = "Nothing to undo";
export const NOTHING_TO_REDO = "Nothing to redo";

export const words = {
  arrange: "Arrange",
  moved: (name: string) => `${name} moved`,
  sourcePlaced: (name: string) => `${name} placed`,
  sourceRemoved: (name: string) => `${name} removed`,
  note: {
    placed: "note placed",
    moved: "note moved",
    resized: "note resized",
    recoloured: "note recoloured",
    edited: "note edited",
    duplicated: "note duplicated",
    removed: "note removed",
    pasted: "note pasted",
  },
  added: (label: string) => `${label} added`,
  pasted: (label: string) => `${label} pasted`,
  removed: (label: string) => `${label} removed`,
  linked: (label: string) => `link to ${label}`,
  linkMoved: (label: string) => `link moved to ${label}`,
  detached: (label: string) => `${label} detached`,
  edited: (label: string) => `${label} edited`,
  renamed: (label: string) => `${label} renamed`,
  discarded: (label: string) => `${label} edit discarded`,
} as const;

/** The reasons a press is refused with, in the record's own cases. */
export const reasons = {
  nothingLeft: (label: string) => `nothing ${label} touched is still on the canvas`,
  gone: (label: string) => `${label} is no longer in the workflow`,
  ranSince: (label: string) => `${label} has run since`,
  forgotten: (label: string) => `${label} was forgotten by a newer step`,
  inRun: (label: string, word: string) => `${label} is ${word}`,
  runAgain: "Its dataset was deleted, so it must run again.",
} as const;

export const nothing = (direction: Direction) => (direction === "undo" ? NOTHING_TO_UNDO : NOTHING_TO_REDO);
export const done = (direction: Direction, step: Step) => `${direction === "undo" ? "Undone" : "Redone"}: ${step.label}`;
export const notDone = (direction: Direction, reason: string) => `${direction === "undo" ? "Not undone" : "Not redone"}: ${reason}`;

// ---- the steps ----

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const samePosition = (a: Position | null | undefined, b: Position | null | undefined) => (a === null || a === undefined) === (b === null || b === undefined) && (!a || !b || (a.x === b.x && a.y === b.y));
const sameDefinition = (a: Definition, b: Definition) => same(a.parameters, b.parameters) && same(a.proposedParameters, b.proposedParameters);

/** Whether a step changes anything at all: a step that does not is none. */
function empty(step: Step): boolean {
  if (step.kind === "layout") return step.delta.members.length === 0 && step.delta.notes.length === 0;
  const op = step.op;
  if (op.kind === "edit") return sameDefinition(op.before, op.after);
  if (op.kind === "discard") return op.before.proposedParameters === null;
  return false;
}

/** The one member of a key move, when it is one. */
function keyMoveOf(step: Step): MemberChange | null {
  if (step.kind !== "layout" || step.name !== "move" || step.by !== "key") return null;
  if (step.delta.members.length !== 1 || step.delta.notes.length !== 0) return null;
  const m = step.delta.members[0];
  return m.before && m.after ? m : null;
}

/** The newest step with this one folded in, or undefined when they do not
 * merge; null when the fold leaves nothing (moved or typed back to where
 * it started). */
function merged(newest: Step, step: Step): Step | null | undefined {
  const a = keyMoveOf(newest);
  const b = keyMoveOf(step);
  if (a && b && a.id === b.id) {
    if (samePosition(a.before, b.after)) return null;
    return { ...newest, delta: { members: [{ id: a.id, before: a.before, after: b.after }], notes: [] } } as LayoutStep;
  }
  if (
    newest.kind === "recipe" &&
    step.kind === "recipe" &&
    newest.op.kind === "edit" &&
    step.op.kind === "edit" &&
    newest.nodeId === step.nodeId &&
    step.op.session !== null &&
    newest.op.session === step.op.session
  ) {
    if (sameDefinition(newest.op.before, step.op.after)) return null;
    return { ...newest, op: { ...newest.op, after: step.op.after } } as RecipeStep;
  }
  return undefined;
}

/** A step made: merged into the newest where the rules say, else added;
 * the undone side forgotten; the newest hundred kept. */
export function record(h: History, step: Step): History {
  if (empty(step)) return h;
  const newest = h.past[h.past.length - 1];
  if (!h.sealed && newest) {
    const fold = merged(newest, step);
    if (fold === null) return { past: h.past.slice(0, -1), future: [], sealed: false };
    if (fold !== undefined) return { past: [...h.past.slice(0, -1), fold], future: [], sealed: false };
  }
  const past = [...h.past, step];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [], sealed: false };
}

/** A boundary: a selection change, a pointer press on the canvas. The
 * next step merges with nothing. */
export const seal = (h: History): History => (h.sealed ? h : { ...h, sealed: true });

/** The step a press would take, or null. */
export function next(h: History, direction: Direction): Step | null {
  const side = direction === "undo" ? h.past : h.future;
  return side[side.length - 1] ?? null;
}

/** The side a press takes from. */
const sideOf = (h: History, direction: Direction) => (direction === "undo" ? h.past : h.future);

/** Whether the record still holds this step on that side: a run's settle
 * can take it away while its inverse is on the wire. */
export const holds = (h: History, direction: Direction, step: Step): boolean => sideOf(h, direction).includes(step);

/** The side named, with this step out of it and the rest in order. Null
 * when the record no longer holds it. */
function without(h: History, direction: Direction, step: Step): Step[] | null {
  const side = sideOf(h, direction);
  const at = side.lastIndexOf(step);
  if (at < 0) return null;
  return [...side.slice(0, at), ...side.slice(at + 1)];
}

/** The step landed: it crosses to the other side. The step **the inverse
 * applied** is named rather than whatever stands newest when the answer
 * comes back: an ordinary edit accepted while the inverse was on the wire
 * has appended a step of its own meanwhile, and crossing that one would
 * say the workflow is in a state it is not. */
export function taken(h: History, direction: Direction, step: Step): History {
  const rest = without(h, direction, step);
  if (!rest) return h;
  return direction === "undo"
    ? { past: rest, future: [...h.future, step], sealed: true }
    : { past: [...h.past, step], future: rest, sealed: true };
}

/** The step cannot pass: it leaves its side, and the next press takes
 * the one before it. The step named, for the reason `taken` names one. */
export function dropped(h: History, direction: Direction, step: Step): History {
  const rest = without(h, direction, step);
  if (!rest) return h;
  return direction === "undo" ? { ...h, past: rest, sealed: true } : { ...h, future: rest, sealed: true };
}

/** Whether a node's last success advanced past the watermark a step carries. */
function advanced(read: string | null, watermark: string | null): boolean {
  if (read === null) return false;
  if (watermark === null) return true;
  return Date.parse(read) > Date.parse(watermark);
}

/** Whether a read shows a node this step names having written its
 * dataset since the step was made: the run boundary's own test, the one
 * `settled` applies, and the one that tells a step a run took from a
 * step a fresh one forgot (the rule's two refusals). A layout step
 * is never outrun. */
export function outrun(step: Step, read: { id: string; lastSuccessAt: string | null }[]): boolean {
  if (step.kind !== "recipe") return false;
  const successes = new Map(read.map((n) => [n.id, n.lastSuccessAt]));
  for (const [id, watermark] of Object.entries(step.watermarks)) {
    if (successes.has(id) && advanced(successes.get(id)!, watermark)) return true;
  }
  return false;
}

/** A run settled: a member that wrote its dataset drops every recipe step
 * naming it, on both sides; a member that failed, was cancelled or did
 * not run advances nothing and keeps them; layout steps stay. */
export function settled(h: History, read: { id: string; lastSuccessAt: string | null }[]): History {
  const keep = (step: Step) => !outrun(step, read);
  const past = h.past.filter(keep);
  const future = h.future.filter(keep);
  return past.length === h.past.length && future.length === h.future.length ? h : { ...h, past, future };
}

/** A node came back under a fresh identity: every step naming the old one
 * names the new one now. */
export function rekeyed(h: History, from: string, to: string): History {
  const id = (x: string) => (x === from ? to : x);
  const rekey = (step: Step): Step => {
    if (step.kind === "layout") {
      if (!step.delta.members.some((m) => m.id === from)) return step;
      return { ...step, delta: { ...step.delta, members: step.delta.members.map((m) => (m.id === from ? { ...m, id: to } : m)) } };
    }
    const names = step.nodeId === from || from in step.watermarks || (step.op.kind === "relink" && (step.op.holder.nodeId === from || step.op.taker.nodeId === from));
    if (!names) return step;
    const watermarks = Object.fromEntries(Object.entries(step.watermarks).map(([k, v]) => [id(k), v]));
    const op: RecipeOp =
      step.op.kind === "relink"
        ? { ...step.op, holder: { ...step.op.holder, nodeId: id(step.op.holder.nodeId) }, taker: { ...step.op.taker, nodeId: id(step.op.taker.nodeId) } }
        : step.op;
    return { ...step, nodeId: id(step.nodeId), watermarks, op };
  };
  return { ...h, past: h.past.map(rekey), future: h.future.map(rekey) };
}

// ---- layout steps as the difference of two snapshots ----

const noteFields = (n: LayoutNote) => ({ x: n.x, y: n.y, w: n.w, h: n.h, color: n.color, text: n.text });
const sameNote = (a: LayoutNote, b: LayoutNote) => same(noteFields(a), noteFields(b));

/** What changed between two snapshots: the members moved, placed or
 * removed and the notes touched, each with its place in the order on
 * each side. Null when nothing changed. */
export function diffLayout(before: LayoutSnapshot, after: LayoutSnapshot): LayoutDelta | null {
  const members: MemberChange[] = [];
  for (const id of new Set([...Object.keys(before.positions), ...Object.keys(after.positions)])) {
    const b = before.positions[id] ?? null;
    const a = after.positions[id] ?? null;
    if (!samePosition(b, a)) members.push({ id, before: b, after: a });
  }
  const notes: NoteChange[] = [];
  const wasAt = new Map(before.notes.map((n, index) => [n.id, { index, note: n }]));
  const isAt = new Map(after.notes.map((n, index) => [n.id, { index, note: n }]));
  for (const id of new Set([...wasAt.keys(), ...isAt.keys()])) {
    const b = wasAt.get(id) ?? null;
    const a = isAt.get(id) ?? null;
    if (b && a && sameNote(b.note, a.note)) continue;
    notes.push({ id, before: b, after: a });
  }
  return members.length === 0 && notes.length === 0 ? null : { members, notes };
}

export interface LayoutInverse {
  /** Every present member's position after the step's side is applied. */
  positions: Positions;
  /** Loose sources the side brings back: they travel the placement road. */
  restored: { id: string; position: Position }[];
  /** Loose sources the side takes away: they travel the drop road. */
  dropped: string[];
  /** The notes as they should read after the side is applied. */
  notes: LayoutNote[];
  /** What the step touched that is gone, left out. */
  leftOut: string[];
}

/** The side of a layout step applied to what the screen shows now: the
 * positions and notes the step changed go back, what was done since
 * stays, a member or a note the step touched that is gone is left out.
 * Null when nothing of the step is left to apply. */
export function layoutInverse(step: LayoutStep, direction: Direction, current: LayoutSnapshot): LayoutInverse | null {
  const positions: Positions = { ...current.positions };
  const restored: LayoutInverse["restored"] = [];
  const droppedIds: string[] = [];
  const leftOut: string[] = [];
  let applied = 0;
  for (const m of step.delta.members) {
    const target = direction === "undo" ? m.before : m.after;
    const present = m.id in current.positions;
    if (target === null) {
      // Placed on this side's other end: it leaves, if it is still there.
      if (present) {
        delete positions[m.id];
        droppedIds.push(m.id);
        applied += 1;
      } else leftOut.push(m.id);
      continue;
    }
    if (present) {
      positions[m.id] = { x: target.x, y: target.y };
      applied += 1;
      continue;
    }
    const other = direction === "undo" ? m.after : m.before;
    if (other === null) {
      // Removed on the other side: it comes back at its position.
      positions[m.id] = { x: target.x, y: target.y };
      restored.push({ id: m.id, position: { x: target.x, y: target.y } });
      applied += 1;
    } else leftOut.push(m.id);
  }
  let notes = [...current.notes];
  for (const n of step.delta.notes) {
    const target = direction === "undo" ? n.before : n.after;
    const other = direction === "undo" ? n.after : n.before;
    const index = notes.findIndex((x) => x.id === n.id);
    if (target === null) {
      if (index >= 0) {
        notes = notes.filter((x) => x.id !== n.id);
        applied += 1;
      } else leftOut.push(n.id);
      continue;
    }
    if (index >= 0) {
      notes[index] = { ...target.note };
      applied += 1;
      continue;
    }
    if (other === null) {
      const at = Math.min(target.index, notes.length);
      notes = [...notes.slice(0, at), { ...target.note }, ...notes.slice(at)];
      applied += 1;
    } else leftOut.push(n.id);
  }
  return applied === 0 ? null : { positions, restored, dropped: droppedIds, notes, leftOut };
}

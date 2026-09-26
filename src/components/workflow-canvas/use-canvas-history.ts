"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { WorkflowStep } from "../workflow-model";
import type { Position, Positions } from "./arrange";
import {
  EMPTY_HISTORY,
  diffLayout,
  done,
  dropped as droppedStep,
  layoutInverse,
  notDone,
  reasons,
  record as recorded,
  seal as sealRecord,
  settled as settledRecord,
  taken,
  words,
  type Definition,
  type Direction,
  type History,
  type LayoutDelta,
  type LayoutName,
  type LayoutStep,
  type RecipeStep,
  type Step,
} from "./canvas-history";
import type { CanvasGraph } from "./graph";
import { controlOwnsKey } from "./key-ownership";
import { readRecipe, runInverse } from "./history-operation";
import { runPress } from "./history-press";
import { definitionOf, effectiveOf, makeRecording, type RecordingEdits } from "./history-recording";
import type { LayoutNote } from "./placement";
import type { EditOutcome, RecipeCoordinator } from "./use-recipe-edits";
import type { LayoutSnapshot } from "./use-layout-saves";

/**
 * The canvas's record, composed with the screen: the pure model in
 * `canvas-history` holds the steps and the rules that shape them; this
 * hook is where the page meets it. A layout step is in the record as soon
 * as the screen shows it, so every change that moves a tile
 * or a note offers its snapshot here **at the change**, never when the
 * delayed save fires: an undo pressed inside that delay finds the step.
 * The record keeps the snapshot the screen last showed and derives each
 * step as the difference from it; a change that belongs to a recipe step
 * (an add's placement, a removal's drop) or to the record's own writes
 * offers its snapshot with no step, so the baseline advances without
 * recording. The baseline follows the **screen**, and the screen takes a
 * newer document only under the notes' pending guard
 * (`use-canvas-notes`), so an older write's echo can reseed neither.
 *
 * The record belongs to this page: empty on open, gone on reload and on
 * leaving, never another workflow's (the canvas is keyed by its
 * workflow), seen by no other tab, user or API.
 */

/** What the record reads off the screen; kept current by the canvas's own
 * commit, so the hook can stand before those callbacks exist. */
export interface HistoryPorts {
  /** A member's position on the screen, read before the call that takes it away. */
  positionOf: (id: string) => Position | null;
  /** The canvas lock's reason while it is locked: a press
   * is inert and says it. */
  lockReason: string | null;
  /** The canvas's notice at its foot. */
  say: (text: string, tone?: "bad") => void;
  /** The frame's whisper: a failure this operation owns, with the Retry
   * that resumes it, as any edit's failure offers. */
  failed: (message: string, retry: () => void) => void;
  /** The failure an inverse owned is over: its step landed or left the
   * record, so the whisper's Retry has nothing left to resume. */
  recovered: () => void;
  /** An open note editor is let commit under its own rule, so its changed
   * text is the newest step before the press takes one. */
  commitNoteEditor: () => void;
  /** The delayed save of a completed move, sent now, so the record's own
   * write queues behind it rather than racing it. */
  settleLayoutSave: () => void;
  /** The open panel's flush: what is typed lands first, as before a run,
   * and an invalid draft refuses with its own reason. */
  flushPanel: () => Promise<EditOutcome | null>;
  /** The screen now: every member's position and the notes as they read. */
  snapshot: () => LayoutSnapshot;
  /** The screen takes these positions; the members named leave it; the
   * members coming back take their spot as a placement, the road a
   * source placed from the pane takes, until the write that brings them
   * back is read. */
  applyPositions: (positions: Positions, gone: string[], restored: { id: string; position: Position }[]) => void;
  /** The notes the screen takes, without recording or writing. */
  applyNotes: (notes: LayoutNote[]) => void;
  /** One write of a step put back, through the roads it needs: the loose
   * sources coming back by their names, the ones leaving by theirs. */
  writeBack: (snapshot: LayoutSnapshot, roads: { place: { id: string; name: string }[]; drop: string[] }) => void;
  /** The tiles glide to their places and the view fits, as Arrange does. */
  glideAndFit: () => void;
  /** The word a member of the run in flight wears while it is unsettled, or null: its recipe steps wait for it. */
  runWord: (nodeId: string) => string | null;
  /** The positions the stored layout document holds. */
  stored: () => Positions;
  /** A node's tile leaves the canvas, through the tail a confirmed
   * removal already has. */
  dropNode: (nodeId: string) => void;
  /** A node's tile takes its spot, by the one road a new node travels. */
  placeNode: (nodeId: string, position: Position) => void;
}

/** What an offer names itself: the words and the roads follow it. */
export interface LayoutOffer {
  name: LayoutName;
  /** A completed move's origin: a drag is one step from
   * pick-up to drop; arrow-key presses on one member merge. */
  by?: "drag" | "key";
  /** The loose source an offer places or takes away, under the name the
   * document holds it by. */
  source?: { id: string; name: string };
}

const NOTE_WORDS: Partial<Record<LayoutName, string>> = {
  note_placed: words.note.placed,
  note_moved: words.note.moved,
  note_resized: words.note.resized,
  note_recoloured: words.note.recoloured,
  note_edited: words.note.edited,
  note_duplicated: words.note.duplicated,
  note_removed: words.note.removed,
  note_pasted: words.note.pasted,
};

/** The word the notice uses for a layout step: the offer names it, and a
 * move takes the name of the member it moved. */
function labelFor(offer: LayoutOffer, delta: LayoutDelta, memberName: (id: string) => string): string {
  if (offer.name === "arrange") return words.arrange;
  if (offer.name === "move") {
    const id = delta.members[0]?.id ?? null;
    return words.moved(id === null ? "The node" : memberName(id));
  }
  if (offer.name === "source_placed") return words.sourcePlaced(offer.source?.name ?? "The source");
  if (offer.name === "source_removed") return words.sourceRemoved(offer.source?.name ?? "The source");
  return NOTE_WORDS[offer.name] ?? words.note.moved;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const filled = (v: unknown) => typeof v === "string" && v !== "";

/** Which of a definition's values the change touched. */
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => !same(before[k], after[k]));
}

export interface CanvasHistory {
  /** Whether a press has a step to take on either side. */
  canUndo: boolean;
  canRedo: boolean;
  /** The coordinator the pane, the panel and the link handlers call: the
   * same shape over the one the screen made, recording what it accepts. */
  edits: RecordingEdits;
  /** An added node's tile took its spot: the position joins the add's own
   * step, so undoing the add takes the placement with it. */
  placed: (nodeId: string, position: Position) => void;
  /** Undo or redo: one step per press, one at a time, each landing before
   * the next is taken. */
  press: (direction: Direction) => void;
  /** The screen changed: the snapshot it now shows, and the step that
   * made it, or null when the change is a recipe step's own or the
   * record's — the baseline advances, nothing is recorded. */
  offer: (snapshot: LayoutSnapshot, step: LayoutOffer | null) => void;
  /** A boundary: a selection change, a pointer press on the canvas. The
   * next step merges with nothing. */
  seal: () => void;
  /** A read changed what is on the canvas (a node added or removed
   * elsewhere, a source arriving): the baseline follows the screen and
   * nothing is recorded. */
  reseed: (snapshot: LayoutSnapshot) => void;
  /** The name a loose source is written under, for the roads a restore
   * travels; null when this page never placed or removed it. */
  sourceName: (id: string) => string | null;
}

export function useCanvasHistory({
  id,
  edits,
  graph,
  operations,
  ports,
}: {
  /** The workflow the record belongs to: what an inverse reads before it
   * applies anything. */
  id: string;
  /** The recipe-edit coordinator the screen made: the road the record's
   * own inverses travel, unrecorded, each request carrying its own resume. */
  edits: RecipeCoordinator;
  graph: CanvasGraph;
  operations: OperationDef[];
  ports: { current: HistoryPorts | null };
}): CanvasHistory {
  /** The record itself: read where a press acts, so never state alone. */
  const state = useRef<History>(EMPTY_HISTORY);
  /** What the buttons show of it. */
  const [shown, setShown] = useState<History>(EMPTY_HISTORY);
  /** The snapshot the screen last showed: every step is the difference from it. */
  const baseline = useRef<LayoutSnapshot | null>(null);
  /** The names loose sources are written under, by their canvas id. */
  const sourceNames = useRef(new Map<string, string>());

  const put = useCallback((next: History) => {
    state.current = next;
    setShown(next);
  }, []);

  /** The recipe and the catalog as the screen holds them, for the words a
   * step uses and the answers it is made against; kept current beside the
   * reconciliation below. */
  const live = useRef({ graph, operations });
  /** A member's own word for the notice: a node's label, a source's name. */
  const memberName = useCallback((id: string) => {
    const m = live.current.graph.members.find((x) => x.id === id);
    return m ? (m.kind === "node" ? m.label : m.name) : "The node";
  }, []);

  const offer = useCallback(
    (snapshot: LayoutSnapshot, step: LayoutOffer | null) => {
      const before = baseline.current;
      baseline.current = snapshot;
      if (step?.source) sourceNames.current.set(step.source.id, step.source.name);
      // Before the first read has seeded the baseline there is nothing to
      // take a difference from; a silent offer only advances it.
      if (!before || !step) return;
      const delta = diffLayout(before, snapshot);
      // A change that changed nothing is no step.
      if (!delta) return;
      put(recorded(state.current, { kind: "layout", name: step.name, by: step.by ?? null, delta, label: labelFor(step, delta, memberName) }));
    },
    [memberName, put],
  );

  // A boundary changes no button: the screen is not told, and the record
  // is read from the ref wherever a press acts.
  const seal = useCallback(() => {
    state.current = sealRecord(state.current);
  }, []);

  const reseed = useCallback((snapshot: LayoutSnapshot) => {
    baseline.current = snapshot;
  }, []);

  const sourceName = useCallback((id: string) => sourceNames.current.get(id) ?? null, []);

  // ---- the recording layer over the coordinator ----

  /** The newest answer this page has for a node, and whether a read has
   * caught up with it: the definition before a step is the newest the page
   * knows, which is this answer while the read is older, else the graph's. */
  const answers = useRef(new Map<string, { definition: Definition; seen: boolean }>());
  useEffect(() => {
    live.current = { graph, operations };
    // The run boundary, read from the recipe as each read lands: a member whose last success has
    // advanced past the
    // watermark a step carries wrote its dataset, and that member's
    // recipe steps leave the record on both sides. A member that failed,
    // was cancelled or did not run advances nothing and keeps them;
    // layout steps and other members' steps stay.
    const read = graph.members.flatMap((m) => (m.kind === "node" ? [{ id: m.id, lastSuccessAt: m.step.lastSuccessAt ?? null }] : []));
    const settledNow = settledRecord(state.current, read);
    if (settledNow !== state.current) put(settledNow);
    for (const [id, held] of answers.current) {
      const m = graph.members.find((x) => x.id === id && x.kind === "node");
      // The node is gone, or the read has passed this answer: the graph speaks.
      if (!m || (m.kind === "node" && held.seen && !same(definitionOf(m.step), held.definition))) answers.current.delete(id);
      else if (m.kind === "node" && same(definitionOf(m.step), held.definition)) held.seen = true;
    }
  }, [graph, operations, put]);

  const memberOf = useCallback((nodeId: string) => {
    const m = live.current.graph.members.find((x) => x.id === nodeId);
    return m && m.kind === "node" ? m : null;
  }, []);
  const labelOf = useCallback(
    (nodeId: string) => memberOf(nodeId)?.label ?? "The node",
    [memberOf],
  );
  /** The newest definition this page knows for a node. */
  const known = useCallback(
    (nodeId: string): Definition | null => {
      const held = answers.current.get(nodeId);
      if (held) return held.definition;
      const m = memberOf(nodeId);
      return m ? definitionOf(m.step) : null;
    },
    [memberOf],
  );
  /** The last success of every node a step names, as it stands now: the
   * watermark the run boundary reads against. */
  const watermarksFor = useCallback(
    (ids: string[]): Record<string, string | null> =>
      Object.fromEntries(ids.map((id) => [id, memberOf(id)?.step.lastSuccessAt ?? null])),
    [memberOf],
  );
  const answered = useCallback((step: WorkflowStep) => {
    answers.current.set(step.id, { definition: definitionOf(step), seen: false });
  }, []);

  /** The word an edit's notice uses: the change itself says whether a link
   * was made or taken off, a name given, or a value edited. */
  const editLabel = useCallback(
    (nodeId: string, before: Definition, after: Definition): string => {
      const label = labelOf(nodeId);
      const from = effectiveOf(before);
      const to = effectiveOf(after);
      const keys = changedKeys(from, to);
      const m = memberOf(nodeId);
      const inputs = new Set(live.current.operations.find((o) => o.id === m?.step.operation)?.inputs.map((i) => i.name) ?? []);
      if (keys.some((k) => inputs.has(k) && filled(to[k]))) return words.linked(label);
      if (keys.some((k) => inputs.has(k))) return words.detached(label);
      if (keys.includes("name")) return words.renamed(label);
      return words.edited(label);
    },
    [labelOf, memberOf],
  );

  /** An operation's own word, for the word an add's notice uses. */
  const operationLabel = useCallback((operation: string) => live.current.operations.find((o) => o.id === operation)?.label ?? operation, []);
  /** What a removal's step must carry, read before the call takes the
   * node away. */
  const removalFacts = useCallback(
    (nodeId: string) => {
      const m = memberOf(nodeId);
      return { operation: m?.step.operation ?? "", ordinal: m?.step.ordinal ?? 0, position: ports.current?.positionOf(nodeId) ?? null };
    },
    [memberOf, ports],
  );

  /** The record as it stands, read where a step is made. */
  const readRecord = useCallback(() => state.current, []);
  /** The page's answer for a node is forgotten: it has left the workflow. */
  const forget = useCallback((nodeId: string) => {
    answers.current.delete(nodeId);
  }, []);
  // The recording layer itself lives in its own module: what it does with
  // an accepted change, and the channel a composite's own edits travel.
  // The layer is made once and takes the screen's ports from an effect,
  // as the edit coordinator and the runner take theirs: it reads them
  // when a change is made, never while the page renders.
  const recording = useMemo(() => makeRecording(), []);
  useEffect(() => {
    recording.setPorts({
      edits,
      record: readRecord,
      put,
      known,
      labelOf,
      operationLabel,
      editLabel,
      answered,
      forget,
      watermarksFor,
      removalFacts,
      retry: {
        lockReason: () => ports.current?.lockReason ?? null,
        say: (text, tone) => ports.current?.say(text, tone),
      },
    });
  });

  // ---- the press: the queue and the pending work (behaviours 5, 6, 7) ----

  /** A layout step put back: the positions and notes it
   * changed go back for what is still on the canvas, what was done since
   * stays where it is, and one snapshot is written through the roads the
   * change needs. The screen leads; the record moves at the offer. */
  const applyLayout = useCallback(
    (step: LayoutStep, direction: Direction, p: HistoryPorts) => {
      const inverse = layoutInverse(step, direction, p.snapshot());
      // Nothing the step touched is still on the canvas: it is dropped,
      // and the next press takes the step before it.
      if (!inverse) {
        put(droppedStep(state.current, direction, step));
        p.say(notDone(direction, reasons.nothingLeft(step.label)), "bad");
        return;
      }
      // An Arrange undone brings the tiles back the way Arrange moved them
      // and fits the view; every other undo and redo holds it.
      if (step.name === "arrange") p.glideAndFit();
      // A member the side brings back has no tile until its write is
      // read: its spot is given to the screen as a placement, so the
      // screen the record reads holds it at once and a redo pressed
      // inside that window finds the step's member rather than nothing
      // (found at review).
      p.applyPositions(inverse.positions, inverse.dropped, inverse.restored);
      if (step.delta.notes.length > 0) p.applyNotes(inverse.notes);
      const snapshot: LayoutSnapshot = { positions: inverse.positions, notes: inverse.notes };
      const isSource = (id: string) => id.startsWith("src:");
      const nameOf = (id: string) => sourceNames.current.get(id) ?? id.slice("src:".length);
      p.writeBack(snapshot, {
        place: inverse.restored.filter((r) => isSource(r.id)).map((r) => ({ id: r.id, name: nameOf(r.id) })),
        drop: inverse.dropped.filter(isSource).map(nameOf),
      });
      // The record moves at the offer, and the baseline with it: a failed
      // write leaves the screen and the record where they are, and the
      // frame's Retry resends the newest snapshot.
      baseline.current = snapshot;
      put(taken(state.current, direction, step));
      p.say(done(direction, step));
    },
    [put],
  );

  /** One press at a time: each lands before the next is taken. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  /** The recipe as it stands, read by the operation before its first
   * attempt and before every Retry. */
  const readSteps = useCallback(() => readRecipe(id), [id]);

  /** A recipe step put back, through the operation that
   * reverses it: the history operation reads first, applies through the
   * appliers, and moves the record when the workflow accepts. Retry
   * belongs to that operation rather than to the coordinator's re-issue
   * of the raw call, so a resumed inverse reads first and finishes what
   * is missing; a resume queues behind whatever press is in flight. */
  const applyRecipe = useCallback(
    (step: RecipeStep, direction: Direction) =>
      runInverse(step, direction, {
        edits,
        screen: () => ports.current,
        read: readSteps,
        record: readRecord,
        put,
        labelOf,
        answered,
        forget,
        enqueue: (job) => {
          queue.current = queue.current.then(job).catch(() => undefined);
        },
      }),
    [answered, edits, forget, labelOf, ports, put, readRecord, readSteps],
  );

  /** The step a press takes and lands. */
  const apply = useCallback(
    async (step: Step, direction: Direction, p: HistoryPorts) => {
      if (step.kind === "layout") applyLayout(step, direction, p);
      else await applyRecipe(step, direction);
    },
    [applyLayout, applyRecipe],
  );

  /** The press itself lives in `history-press`: the lock, the pending
   * work landed as a run lands it, then one step through the applier its
   * kind needs. The screen is read there when the press runs. */
  const take = useCallback(
    (direction: Direction) =>
      runPress(direction, {
        screen: () => ports.current,
        edits,
        record: readRecord,
        seal,
        apply: async (step, d) => {
          const p = ports.current;
          if (p) await apply(step, d, p);
        },
      }),
    [apply, edits, ports, readRecord, seal],
  );

  const press = useCallback(
    (direction: Direction) => {
      queue.current = queue.current.then(() => take(direction)).catch(() => undefined);
    },
    [take],
  );

  // The chord, at the document while the canvas is mounted: the whole workflow page counts, the
  // body included, since a press on a stage button or on empty ground can leave focus there and
  // that is the very gesture (Arrange, then the chord). The modifier with *z* undoes, with *shift*
  // or *y* redoes, exactly as the builder binds it; an editable control and an open dialog keep the
  // key as their own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // A held chord auto-repeats many times a second: one step per
      // press, a held chord no more (the builder's rule).
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const redo = (key === "z" && e.shiftKey) || key === "y";
      const undo = key === "z" && !e.shiftKey;
      if (!undo && !redo) return;
      if (controlOwnsKey(e.target)) return;
      e.preventDefault();
      press(redo ? "redo" : "undo");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [press]);

  const placed = useCallback(
    (nodeId: string, position: Position) => {
      const past = [...state.current.past];
      for (let i = past.length - 1; i >= 0; i -= 1) {
        const step = past[i];
        if (step.kind !== "recipe" || step.nodeId !== nodeId || step.op.kind !== "add") continue;
        past[i] = { ...step, op: { ...step.op, position } };
        put({ ...state.current, past });
        return;
      }
    },
    [put],
  );

  return useMemo(
    () => ({ canUndo: shown.past.length > 0, canRedo: shown.future.length > 0, edits: recording.edits, offer, placed, press, reseed, seal, sourceName }),
    [offer, placed, press, recording, reseed, seal, shown, sourceName],
  );
}

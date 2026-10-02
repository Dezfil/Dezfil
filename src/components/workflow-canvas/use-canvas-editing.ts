"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { applyNodeChanges, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { assistantOwnsEscape } from "../builder/assistant/escape-owner";
import { defaultOutputName, initialParameters, registeredName } from "../builder/drawer/operation-form";
import { arrangeByDependency, GRID, NODE_H, NODE_W, type Positions } from "./arrange";
import { freeRectOf } from "./CanvasFurniture";
import type { DropPoint } from "./CanvasPane";
import type { LayoutName } from "./canvas-history";
import { pasteSource, writeClipboardItem, type ClipboardItem } from "./clipboard-items";
import { effectiveParameters, type CanvasGraph, type NodeMember, type SourceMember } from "./graph";
import { acceptsClass, expectedClass, outputNameOf } from "./link-rules";
import type { LayoutNote, LayoutRead } from "./placement";
import { sourceKeptBecause } from "./removal-model";
import { nudgeDiagonal, nudgeFree, screenPositions } from "./screen-positions";
import { isMemberNode, isNoteNode, noteNodeId, type FlowNode, type ReadFlowEdge } from "./to-flow";
import { useCanvasClipboard, type CopyAnswer } from "./use-canvas-clipboard";
import { useCanvasHistory, type HistoryPorts } from "./use-canvas-history";
import { useCanvasLinks } from "./use-canvas-links";
import { useCanvasLock } from "./use-canvas-lock";
import { useCanvasNotes } from "./use-canvas-notes";
import { useLayoutSaves, type LayoutSnapshot, type SaveState } from "./use-layout-saves";
import type { RecipeCoordinator } from "./use-recipe-edits";
import type { WorkflowRunner } from "./use-workflow-run";
import { fitOptions } from "./view";

/**
 * The canvas's interaction and edit wiring, out of `WorkflowCanvas.tsx`
 * under the decomposition rule, beside the lock it reads: moving members
 * and the layout writes a completed move makes, Arrange, adding a tool or
 * a source, linking, selecting, removing, the keys that mutate, copy and
 * paste, the notes coordinator, and the record's ports that undo and redo
 * go through. The renderer keeps drawing members, edges, notes and the
 * results band, and sets its editing flags from this hook's gate.
 *
 * The gate is the one place that answers "may this person edit the canvas
 * now": every mutating interaction here reads it, and so does every flag
 * the renderer sets for editing (dragging, linking, reconnecting, the
 * note menu, the refused controls' reason). Today the canvas lock alone
 * closes it. The lock's own button and its Unlock stay the lock's.
 */

/** What the header's Undo and Redo read, and the press they make. */
export interface HistoryChrome {
  canUndo: boolean;
  canRedo: boolean;
  /** The lock's reason while locked: both buttons are inert and say it. */
  reason: string | null;
  press: (direction: "undo" | "redo") => void;
  /** Called on the button's pointerdown: the record is sealed as it is by
   * a pointerdown on the canvas, so a value still pending in a panel field
   * becomes its own step when the press lands it, never a fold into the
   * step before. */
  seal: () => void;
}

/** May this person edit the canvas now: closed, nothing moves, links,
 * adds, removes, pastes or writes, and every refused control says the
 * reason. */
export interface CanvasEditGate {
  locked: boolean;
  reason: string | null;
}

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function useCanvasEditing({
  id,
  graph,
  layout,
  tables,
  operations,
  onSaveState,
  onEditState,
  onHistory,
  onLayoutWritten,
  edits: rawEdits,
  addSourceRequest,
  runner,
  flow,
  say,
  hush,
  view,
  viewRef,
  reserveRef,
  fitPanelRef,
  helperRightRef,
  setAnimating,
  nodes,
  setNodes,
  nodesRef,
  placementsRef,
  setPlacements,
  setPendingSelect,
  selectedMember,
  hostRef,
}: {
  id: string;
  graph: CanvasGraph;
  layout: LayoutRead;
  tables: TableListing[];
  operations: OperationDef[];
  onSaveState: (state: SaveState) => void;
  onEditState: (state: SaveState) => void;
  onHistory: (state: HistoryChrome) => void;
  onLayoutWritten: (layout: LayoutRead) => void;
  edits: RecipeCoordinator;
  addSourceRequest: { names: string[]; seq: number } | null;
  runner: WorkflowRunner;
  flow: ReactFlowInstance<FlowNode, ReadFlowEdge>;
  /** The canvas's foot notice, which the coordinators' Retry ports speak through. */
  say: (text: string, tone?: "bad", hold?: boolean) => void;
  hush: () => void;
  /** The view and the furniture the fits keep clear of. */
  view: "full" | "framed";
  viewRef: RefObject<"full" | "framed">;
  reserveRef: RefObject<number>;
  fitPanelRef: RefObject<boolean>;
  helperRightRef: RefObject<number>;
  setAnimating: Dispatch<SetStateAction<boolean>>;
  /** The members and notes on screen, and the placements no read has echoed yet. */
  nodes: FlowNode[];
  setNodes: Dispatch<SetStateAction<FlowNode[]>>;
  nodesRef: RefObject<FlowNode[]>;
  placementsRef: RefObject<Positions>;
  setPlacements: Dispatch<SetStateAction<Positions>>;
  /** A pasted member to select on its first reconciliation. */
  setPendingSelect: Dispatch<SetStateAction<string | null>>;
  selectedMember: CanvasGraph["members"][number] | null;
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  // The canvas lock: this page's way of looking.
  const lock = useCanvasLock();
  // May this person edit the canvas now, and if not, why: the one gate
  // every mutating interaction below reads, and every flag the renderer
  // sets for editing. Today the lock alone closes it.
  const gate = useMemo<CanvasEditGate>(
    () => ({ locked: lock.locked, reason: lock.reason }),
    [lock.locked, lock.reason],
  );
  const readLockReason = useCallback(() => gate.reason, [gate.reason]);
  // This page's record of its own steps. Its ports are filled by the
  // commit below, so the record can stand before the screen's own
  // callbacks exist, as the edit coordinator's are.
  const historyPorts = useRef<HistoryPorts | null>(null);
  const history = useCanvasHistory({ id, edits: rawEdits, graph, operations, ports: historyPorts });
  useEffect(() => {
    rawEdits.setRetryPorts({ lockReason: readLockReason, say });
  }, [rawEdits, readLockReason, say]);
  const historyPress = history.press;
  const historySeal = history.seal;
  useEffect(() => {
    onHistory({ canUndo: history.canUndo, canRedo: history.canRedo, reason: gate.reason, press: historyPress, seal: historySeal });
  }, [onHistory, history.canUndo, history.canRedo, gate.reason, historyPress, historySeal]);
  // What the pane, the panels and the link handlers call: the same
  // coordinator, recording what the workflow accepts. The record's own
  // inverses travel the unrecorded road, `rawEdits`.
  const edits = history.edits;
  // The record's own entries, each stable across its changes: an effect or
  // a callback that depended on the record itself would run again at every
  // step it took, and the boundary drawn in one would end every merge
  // before it began (the stage's probe: five arrow presses became five
  // steps).
  const { offer: offerLayout, placed: placedAt, reseed: reseedRecord, seal: sealRecord } = history;
  // Arrange is the stage stack's own action: each press is one request.
  const [arrangeRequest, setArrangeRequest] = useState(0);
  /** This page's copy chain: what was copied, every paste of it, and the
   * item's own text, so an item from elsewhere never rides its diagonal. */
  const copyChain = useRef<{ from: string | null; pasted: Set<string>; last: string | null; key: string | null }>({ from: null, pasted: new Set(), last: null, key: null });
  /** Names and spots handed to pastes not read back yet (the spots by the
   * pasted step's id, held until the graph shows it): rapid pastes never collide. */
  const reserved = useRef<{ names: Set<string>; spots: Positions }>({ names: new Set(), spots: {} });
  const { save, placeSource, dropSource, dropStep, restore, pending: writesPending } = useLayoutSaves({
    id,
    layout,
    graph,
    onState: onSaveState,
    onWritten: onLayoutWritten,
    lockReason: readLockReason,
    say,
  });

  // A completed move — a pointer drag's end or an arrow key's step — is a
  // position change that is not dragging; the many that arrive together
  // (a drag's last batch, a held key) become one write.
  const pending = useRef<number | null>(null);
  /** Every member's position as the screen holds it: the tiles it shows,
   * over a placement no read has echoed yet — a source just placed, a
   * node just added or just brought back. The record must read the same
   * screen the user sees, or an undo taken in that window finds the
   * member already gone ((d) and 3(f)); `gone` leaves out a member on its
   * way off the canvas. */
  const screenNow = useCallback((gone?: string) => screenPositions(nodesRef.current, placementsRef.current, gone), [nodesRef, placementsRef]);
  // The notes as they are now: every write carries them with the
  // positions, so a note changed while a write is in flight rides the
  // next, and Retry sends the newest. The notes hook keeps this current.
  const notesRef = useRef<LayoutNote[]>(layout.notes);
  const snapshotOf = useCallback((positions: Positions): LayoutSnapshot => ({ positions, notes: notesRef.current }), []);
  const saveSoon = useCallback(() => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      save(snapshotOf(screenNow()));
    }, 80);
  }, [save, screenNow, snapshotOf]);
  /** The delayed save of a completed move, sent now (behaviour
   * 5): a press settles it, so the record's own write queues behind it. */
  const settleLayoutSave = useCallback(() => {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
    save(snapshotOf(screenNow()));
  }, [save, screenNow, snapshotOf]);
  // A note's changes are the notes hook's; a member's completed move writes
  // as before.
  const applyNoteChange = useRef<(change: NodeChange<FlowNode>) => boolean>(() => false);
  /** A completed move waiting to be recorded, with its origin: the library
   * reports dragging before a drag's own completion, and never for a key. */
  const moved = useRef<{ by: "drag" | "key" } | null>(null);
  const dragging = useRef(false);
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      // Locked, no move is written: none can start, and one admitted before
      // the lock completes under its own outcome.
      let memberMoved = false;
      for (const c of changes) {
        if (applyNoteChange.current(c)) continue;
        if (c.type !== "position") continue;
        if (c.dragging === true) dragging.current = true;
        if (c.dragging === false) memberMoved = true;
      }
      if (memberMoved) {
        // A drag is one step from pick-up to drop; arrow presses on one
        // member merge into one.
        moved.current = { by: dragging.current ? "drag" : "key" };
        dragging.current = false;
        saveSoon();
      }
    },
    [saveSoon, setNodes],
  );
  // The completed move is in the record as soon as the screen shows it: captured in the commit that
  // moves the tile, not when
  // the delayed save fires, so an undo pressed inside that delay finds it.
  useEffect(() => {
    const m = moved.current;
    if (!m) return;
    moved.current = null;
    offerLayout(snapshotOf(screenNow()), { name: "move", by: m.by });
  }, [nodes, offerLayout, screenNow, snapshotOf]);

  // Arrange by dependency: every visible member moves, the
  // move animates unless motion is reduced, the view fits, and the result
  // is written.
  const lastArrange = useRef(arrangeRequest);
  useEffect(() => {
    if (arrangeRequest === lastArrange.current) return;
    lastArrange.current = arrangeRequest;
    const target = arrangeByDependency(graph.members, graph.edges);
    const animate = !reducedMotion();
    setAnimating(animate);
    setNodes((current) =>
      current.map((n) => (target[n.id] ? { ...n, position: target[n.id] } : n)),
    );
    // One step for every member it moved; one that moves nothing is none.
    const snapshot = snapshotOf(target);
    offerLayout(snapshot, { name: "arrange" });
    save(snapshot);
    const settle = window.setTimeout(
      () => {
        setAnimating(false);
        void flow.fitView({ ...fitOptions(view, fitPanelRef.current, reserveRef.current, helperRightRef.current), duration: animate ? 240 : 0 });
      },
      animate ? 320 : 0,
    );
    return () => window.clearTimeout(settle);
    // The view is read when Arrange fires; a later toggle re-fits on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrangeRequest, flow, graph, offerLayout, save, snapshotOf]);

  // adding from the pane ----
  /** The screen rect of the canvas the pane does not cover. */
  const freeRect = useCallback(() => (hostRef.current ? freeRectOf(hostRef.current) : null), [hostRef]);
  /** A member placed out of the free view — under the panel, past an
   * edge — is brought into it, keeping the zoom. */
  const reveal = useCallback(
    (position: Positions[string]) => {
      const r = freeRect();
      if (!r) return;
      const tl = flow.flowToScreenPosition({ x: position.x, y: position.y });
      const br = flow.flowToScreenPosition({ x: position.x + NODE_W, y: position.y + NODE_H });
      const inside = tl.x >= r.left && br.x <= r.right && tl.y >= r.top && br.y <= r.bottom;
      if (inside) return;
      const zoom = flow.getZoom();
      const centre = flow.screenToFlowPosition({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
      const current = flow.getViewport();
      // Pan by the offset between the free area's centre and the node's.
      const dx = (centre.x - (position.x + NODE_W / 2)) * zoom;
      const dy = (centre.y - (position.y + NODE_H / 2)) * zoom;
      void flow.setViewport({ x: current.x + dx, y: current.y + dy, zoom }, { duration: 220 });
    },
    [flow, freeRect],
  );
  const isOverCanvas = useCallback(
    (x: number, y: number) => {
      const r = freeRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },
    [freeRect],
  );
  /** A drop point, or the free canvas's centre, in canvas units, for a
   * member's top-left. */
  const placeAt = useCallback(
    (at: DropPoint, w: number, h: number, also: Positions = {}): Positions[string] => {
      const r = freeRect();
      const screen = at ?? (r ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : { x: 0, y: 0 });
      const p = flow.screenToFlowPosition(screen);
      const spot = { x: Math.round((p.x - w / 2) / GRID) * GRID, y: Math.round((p.y - h / 2) / GRID) * GRID };
      // A spot already taken (the second add in view lands where the first
      // did) steps right until it is free, so members never stack; `also`
      // carries spots given in the same pass, before the nodes reflect them.
      return at === null ? nudgeFree(spot, { ...screenNow(), ...also }, w, h) : spot;
    },
    [flow, freeRect, screenNow],
  );
  /** The one road a new node takes to its spot (the pane's click and a
   * paste alike,): the transient placement, the layout write with it,
   * and the view brought to it. */
  const placeAdded = useCallback(
    (id: string, position: Positions[string]) => {
      setPlacements((p) => ({ ...p, [id]: position }));
      // The layout is written whole: a paste placed moments ago and not
      // read back yet rides along by its reserved spot, or the later write
      // would drop it.
      const snapshot = snapshotOf({ ...screenNow(), ...reserved.current.spots, [id]: position });
      // The placement belongs to the add's own step: it joins that step,
      // and the baseline advances with no layout step of its own.
      placedAt(id, position);
      offerLayout(snapshot, null);
      save(snapshot);
      reveal(position);
    },
    [offerLayout, placedAt, reveal, save, screenNow, setPlacements, snapshotOf],
  );
  const addTool = useCallback(
    async (op: OperationDef, at: DropPoint) => {
      const parameters = initialParameters(op);
      // The selected member's output pre-set as the first input, when the
      // input accepts it.
      const first = op.inputs[0];
      let preset: string | null = null;
      if (first && selectedMember) {
        const name = outputNameOf(selectedMember);
        if (name && acceptsClass(first.accepts, expectedClass(selectedMember, graph, operations, tables))) {
          parameters[first.name] = name;
          preset = name;
        }
      }
      // A free name, numbered against the tables and this workflow's declarations.
      const declared = new Set(
        graph.members.flatMap((m) =>
          m.kind === "node"
            ? [m.step.output?.name, m.step.parameters.name, m.step.proposedParameters?.name]
                .filter((n): n is string => typeof n === "string" && n !== "")
                .map((n) => registeredName(n))
            : [],
        ),
      );
      const registered = new Set(tables.map((t) => t.name.toLowerCase()));
      parameters.name = defaultOutputName(op, preset, (n) => registered.has(n) || declared.has(n));
      const outcome = await edits.add({ operation: op.id, parameters });
      if (outcome.kind === "refused") say(outcome.message, "bad");
      if (outcome.kind !== "accepted" || !outcome.step) return;
      const id = outcome.step.id;
      // Beside the selected member when pre-linked and not dropped, else at the drop or in view.
      const position =
        preset && at === null && selectedMember
          ? (() => {
              const anchor = nodes.find((n) => n.id === selectedMember.id);
              return anchor
                ? nudgeFree({ x: anchor.position.x + NODE_W + 96, y: anchor.position.y }, screenNow(), NODE_W, NODE_H)
                : placeAt(null, NODE_W, NODE_H);
            })()
          : placeAt(at, NODE_W, NODE_H);
      placeAdded(id, position);
    },
    [edits, graph, nodes, operations, placeAdded, placeAt, say, screenNow, selectedMember, tables],
  );
  const addSource = useCallback(
    (name: string, at: DropPoint, also: Positions = {}): Positions[string] => {
      const id = `src:${name.trim().toLowerCase()}`;
      const position = placeAt(at, NODE_W, NODE_H, also);
      setPlacements((p) => ({ ...p, [id]: position }));
      // A loose source is a layout fact: the write carries it
      // by name beside every position on screen.
      const snapshot = snapshotOf({ ...screenNow(), ...also, [id]: position });
      offerLayout(snapshot, { name: "source_placed", source: { id, name } });
      placeSource(id, name, snapshot);
      if (at === null) reveal(position);
      return position;
    },
    [offerLayout, placeAt, placeSource, reveal, screenNow, setPlacements, snapshotOf],
  );
  // Several tables from one import (a container) each take their own spot.
  const addSources = useCallback(
    (names: string[]) => {
      if (gate.reason) {
        say(gate.reason, "bad");
        return;
      }
      const given: Positions = {};
      for (const name of names) given[`src:${name.trim().toLowerCase()}`] = addSource(name, null, given);
    },
    [addSource, gate.reason, say],
  );
  // A table the dialog brought in, placed as a loose source in view.
  const lastImport = useRef<number>(0);
  useEffect(() => {
    if (!addSourceRequest || addSourceRequest.seq === lastImport.current) return;
    lastImport.current = addSourceRequest.seq;
    const names = addSourceRequest.names;
    queueMicrotask(() => addSources(names));
  }, [addSources, addSourceRequest]);

  // connections, the canvas's own hook ----
  const { isValidConnection, onConnect, onConnectEnd, onReconnectStart, onReconnect, onReconnectEnd } = useCanvasLinks({
    graph,
    operations,
    tables,
    runner,
    edits,
    say,
  });

  // ---- the panels (behaviours 4, 5): selection is the library's; closing,
  // Escape and a canvas click clear it ----
  const deselect = useCallback(() => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n))), [setNodes]);
  const selectMember = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      const target = nodesRef.current.find((n) => n.id === id);
      if (target) void flow.setCenter(target.position.x + NODE_W / 2, target.position.y + NODE_H / 2, { zoom: flow.getZoom(), duration: 240 });
    },
    [flow, nodesRef, setNodes],
  );
  const removeSource = useCallback(
    (m: SourceMember) => {
      setPlacements((p) => {
        const next = { ...p };
        delete next[m.id];
        return next;
      });
      deselect();
      const snapshot = snapshotOf(screenNow(m.id));
      offerLayout(snapshot, { name: "source_removed", source: { id: m.id, name: m.name } });
      dropSource(m.name, snapshot);
    },
    [deselect, dropSource, offerLayout, screenNow, setPlacements, snapshotOf],
  );
  // ---- removal: one truthful question, then the node is
  // gone and its position leaves the layout; a loose source nothing needs
  // goes without asking ----
  const [pendingRemoval, setPendingRemoval] = useState<NodeMember | null>(null);
  const [removing, setRemoving] = useState(false);
  // Focus recovers once the confirmation has gone: the dialog hands focus
  // back to its opener on unmount, and the opener was the removed node's
  // panel, so the canvas takes it after that.
  const focusAfter = useRef(false);
  // Focus returns to the canvas area itself: the library's wrapper takes no
  // focus, and a removed member's tile is gone.
  const focusCanvas = useCallback(() => {
    hostRef.current?.querySelector<HTMLElement>("[data-flow-area]")?.focus();
  }, [hostRef]);

  // notes: the coordinator beside the canvas ----
  const focusNoteNode = useCallback((id: string) => {
    // The id is the writer's own: escaped, so a quote in it cannot break
    // the selector (found at review).
    hostRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(noteNodeId(id))}"]`)?.focus();
  }, [hostRef]);
  const focusNoteTool = useCallback(() => {
    hostRef.current?.querySelector<HTMLElement>("[data-note-tool]")?.focus();
  }, [hostRef]);
  const writeNotes = useCallback(
    (list: LayoutNote[], name: LayoutName) => {
      // The notes as they are now, before anything else reads them: a
      // member's move captured in the same tick carries them too.
      notesRef.current = list;
      const snapshot: LayoutSnapshot = { positions: screenNow(), notes: list };
      offerLayout(snapshot, { name });
      save(snapshot);
    },
    [offerLayout, save, screenNow],
  );
  const notesCtl = useCanvasNotes({ layout, flow, write: writeNotes, say, hush, deselect, focusCanvas, focusTool: focusNoteTool, focusNote: focusNoteNode, freeRect, writesPending, lockReason: gate.reason });
  useEffect(() => {
    notesRef.current = notesCtl.notes;
  }, [notesCtl.notes]);
  useEffect(() => {
    applyNoteChange.current = notesCtl.applyChange;
  }, [notesCtl.applyChange]);
  // A read changes what is on the canvas (a node added or removed
  // elsewhere, a source arriving, a newer document's notes): the record's
  // baseline follows the screen, and nothing is recorded. It stands after
  // the notes' own sync above, so the snapshot is the screen as committed.
  useEffect(() => {
    reseedRecord({ positions: screenNow(), notes: notesRef.current });
  }, [graph, layout, reseedRecord, screenNow]);
  // The boundary a run of arrow keys ends at: a selection
  // change here, a pointer press on the canvas below.
  const selectionKey = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id).join(" "), [nodes]);
  useEffect(() => {
    sealRecord();
  }, [sealRecord, selectionKey]);
  // The record's ports, kept current by every commit, as the edit
  // coordinator's are: the record composes what the screen holds.
  const positionOf = useCallback((id: string) => nodesRef.current.find((n) => n.id === id)?.position ?? null, [nodesRef]);
  /** An open note editor commits under its own rule (its blur), as locking
   * lets it: a click on a stage button blurs it first, and the chord must. */
  const commitNoteEditor = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("[data-note-field]")) active.blur();
  }, []);
  /** The screen as the record reads it back. */
  const snapshot = useCallback((): LayoutSnapshot => ({ positions: screenNow(), notes: notesRef.current }), [screenNow]);
  /** The positions a step of the record puts back, the members that
   * leave the canvas with it, and the ones that come back: the screen
   * leads, before the write. A member coming back has no tile until its
   * write is read, so its spot is a placement, as a source placed from
   * the pane takes one; the placements' ref follows at once, as the
   * nodes' does, since the next press can read the screen before the
   * commit (found at review). */
  const applyPositions = useCallback((positions: Positions, gone: string[], restored: { id: string; position: Positions[string] }[]) => {
    const next = nodesRef.current
      .filter((n) => !gone.includes(n.id))
      .map((n) => (isMemberNode(n) && positions[n.id] ? { ...n, position: positions[n.id] } : n));
    nodesRef.current = next;
    setNodes(next);
    if (gone.length === 0 && restored.length === 0) return;
    const rest = { ...placementsRef.current };
    for (const id of gone) delete rest[id];
    for (const r of restored) rest[r.id] = r.position;
    placementsRef.current = rest;
    setPlacements(rest);
  }, [nodesRef, placementsRef, setNodes, setPlacements]);
  const applyNotes = useCallback(
    (list: LayoutNote[]) => {
      notesRef.current = list;
      notesCtl.apply(list);
    },
    [notesCtl],
  );
  /** The tiles glide and the view fits, as Arrange does. */
  const glideAndFit = useCallback(() => {
    const animate = !reducedMotion();
    setAnimating(animate);
    window.setTimeout(
      () => {
        setAnimating(false);
        void flow.fitView({ ...fitOptions(viewRef.current, fitPanelRef.current, reserveRef.current, helperRightRef.current), duration: animate ? 240 : 0 });
      },
      animate ? 320 : 0,
    );
  }, [fitPanelRef, flow, helperRightRef, reserveRef, setAnimating, viewRef]);
  /** The tail a removed node's tile takes: its
   * placement forgotten, its tile gone, its position out of the next
   * write, and no layout step of its own, since the drop belongs to the
   * removal. The record's own removals travel it too. */
  const dropTile = useCallback(
    (nodeId: string) => {
      setPlacements((p) => {
        const next = { ...p };
        delete next[nodeId];
        return next;
      });
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      const snapshot = snapshotOf(screenNow(nodeId));
      offerLayout(snapshot, null);
      dropStep(nodeId, snapshot);
    },
    [dropStep, offerLayout, screenNow, setNodes, setPlacements, snapshotOf],
  );
  /** The word a member of the run in flight wears while it is unsettled
   * its recipe steps wait for it. */
  const runWord = useCallback(
    (nodeId: string) => {
      if (!runner.unsettled(nodeId)) return null;
      const m = graph.members.find((x) => x.id === nodeId);
      return (m?.kind === "node" ? m.run?.word : null) ?? "running";
    },
    [graph, runner],
  );
  useEffect(() => {
    historyPorts.current = {
      positionOf,
      lockReason: gate.reason,
      say,
      failed: (message, retry) => onEditState({ kind: "failed", message, retry }),
      recovered: () => onEditState({ kind: "saved" }),
      commitNoteEditor,
      settleLayoutSave,
      flushPanel: runner.flushPanel,
      snapshot,
      applyPositions,
      applyNotes,
      writeBack: restore,
      glideAndFit,
      runWord,
      stored: () => layout.steps,
      dropNode: dropTile,
      placeNode: placeAdded,
    };
  });
  // ---- copy and paste ----
  const copyItem = useCallback(async (): Promise<CopyAnswer> => {
    const selected = nodesRef.current.find((n) => n.selected);
    if (!selected) return null;
    if (isNoteNode(selected)) {
      const note = selected.data.note;
      const item: ClipboardItem = { kind: "note", text: note.text, color: note.color, w: note.w, h: note.h };
      copyChain.current = { from: selected.id, pasted: new Set(), last: null, key: writeClipboardItem(item) };
      return { item, said: "Copied the note." };
    }
    const m = graph.members.find((x) => x.id === selected.id);
    if (!m) return null;
    if (m.kind === "source") return { invalidate: { text: m.name, said: `${m.name} is on the canvas once; nothing to copy.` } };
    // What the panel shows: its draft as it stands, whether or not a save
    // of it is already on the wire; an invalid draft copies nothing and
    // says its reason. The draft lands through its own flush meanwhile.
    const draft = runner.panelDraft();
    if (draft?.invalid) return { refuse: draft.invalid };
    void runner.flushPanel();
    const item: ClipboardItem = { kind: "node", operation: m.step.operation, parameters: draft ? { ...draft.values } : effectiveParameters(m.step), source: id };
    copyChain.current = { from: m.id, pasted: new Set(), last: null, key: writeClipboardItem(item) };
    return { item, said: `Copied ${m.label}.` };
  }, [graph, id, nodesRef, runner]);
  const pasteItem = useCallback(
    async (item: ClipboardItem) => {
      // The item's own chain sets the diagonal; another item's paste starts
      // a chain of its own, notes included.
      const key = writeClipboardItem(item);
      if (copyChain.current.key !== key) copyChain.current = { from: null, pasted: new Set(), last: null, key };
      if (item.kind === "note") {
        notesCtl.pasteNote(item, copyChain.current);
        return;
      }
      const op = operations.find((o) => o.id === item.operation);
      if (!op) {
        // Unknown here: the add operation refuses it in its own words.
        const refusal = await edits.add({ operation: item.operation, parameters: item.parameters, ...pasteSource(item, id) });
        say(refusal.kind === "refused" ? refusal.message : `“${item.operation}” is not a tool this instance knows.`, "bad");
        return;
      }
      if (op.availability && !op.availability.available) {
        say(`${op.label}: ${op.availability.reason}`, "bad");
        return;
      }
      // A fresh name by the add rule: the first input's name and the
      // operation, numbered against the workspace and this workflow.
      const declared = new Set(
        graph.members.flatMap((mm) =>
          mm.kind === "node"
            ? [mm.step.output?.name, mm.step.parameters.name, mm.step.proposedParameters?.name]
                .filter((n): n is string => typeof n === "string" && n !== "")
                .map((n) => registeredName(n))
            : [],
        ),
      );
      const registered = new Set(tables.map((t) => t.name.toLowerCase()));
      // A name or spot reserved by an earlier paste is taken until the graph
      // reads it back; the item's own chain sets the diagonal, another
      // item's paste starts a chain of its own.
      const held = reserved.current;
      for (const n of held.names) if (declared.has(n)) held.names.delete(n);
      for (const sid of Object.keys(held.spots)) if (graph.members.some((mm) => mm.id === sid)) delete held.spots[sid];
      const first = op.inputs[0];
      const firstName = first && typeof item.parameters[first.name] === "string" ? (item.parameters[first.name] as string) : null;
      const name = defaultOutputName(op, firstName, (n) => registered.has(n) || declared.has(n) || held.names.has(n));
      held.names.add(name);
      // Down the diagonal from the copied node or the last paste of it,
      // to the next free step; else in view, as a pane click places one.
      const selected = nodesRef.current.find((n) => n.selected);
      const chain = copyChain.current;
      // The copied node or the most recent paste of it anchors; an earlier paste does not.
      const anchor = selected && (selected.id === chain.from || selected.id === chain.last) ? selected : null;
      const taken = { ...screenNow(), ...held.spots };
      const position = anchor ? nudgeDiagonal({ x: anchor.position.x + 24, y: anchor.position.y + 24 }, taken) : placeAt(null, NODE_W, NODE_H, held.spots);
      const spotKey = `paste:${name}`;
      held.spots[spotKey] = position;
      // Values copied in another workflow are carried from there.
      const outcome = await edits.add({ operation: op.id, parameters: { ...item.parameters, name }, ...pasteSource(item, id) }, { pasted: true });
      delete held.spots[spotKey];
      if (outcome.kind !== "accepted" || !outcome.step) {
        held.names.delete(name);
        if (outcome.kind === "refused") say(outcome.message, "bad");
        return;
      }
      const added = outcome.step.id;
      held.spots[added] = position;
      chain.pasted.add(added);
      chain.last = added;
      setPendingSelect(added);
      placeAdded(added, position);
      say(`Pasted ${op.label} as ${name}.`);
    },
    [edits, graph, id, nodesRef, notesCtl, operations, placeAdded, placeAt, say, screenNow, setPendingSelect, tables],
  );
  useCanvasClipboard({ host: hostRef, copy: copyItem, paste: (item) => void pasteItem(item), say, lockReason: gate.reason });
  const confirmRemoval = useCallback(async () => {
    const m = pendingRemoval;
    if (!m) return;
    if (runner.unsettled(m.step.id)) {
      setPendingRemoval(null);
      say(`${m.label} is part of the run in flight. It can be removed once it settles.`, "bad");
      return;
    }
    setRemoving(true);
    const outcome = await edits.remove(m.step.id);
    setRemoving(false);
    if (outcome.kind === "refused") {
      say(outcome.message, "bad");
      return;
    }
    if (outcome.kind !== "accepted") return;
    setPendingRemoval(null);
    dropTile(m.id);
    say(outcome.answer.message);
    focusAfter.current = true;
  }, [dropTile, edits, pendingRemoval, runner, say]);
  useEffect(() => {
    if (pendingRemoval !== null || !focusAfter.current) return;
    focusAfter.current = false;
    focusCanvas();
  }, [focusCanvas, pendingRemoval]);
  const askRemoval = useCallback(
    (m: NodeMember) => {
      if (gate.reason) {
        say(gate.reason, "bad");
        return;
      }
      // Not while the run in flight has it: at offer and,
      // below, again at commit.
      if (runner.unsettled(m.step.id)) {
        say(`${m.label} is part of the run in flight. It can be removed once it settles.`, "bad");
        return;
      }
      setPendingRemoval(m);
    },
    [gate.reason, runner, say],
  );
  // A confirmation open on a member that becomes unsettled is dismissed
  // (adjusted during render, as the graph's re-read brings the run's word).
  if (pendingRemoval && runner.unsettled(pendingRemoval.step.id)) setPendingRemoval(null);
  const tryRemoveSource = useCallback(
    (m: SourceMember) => {
      const why = gate.reason ?? sourceKeptBecause(m, graph);
      if (why) {
        say(why, "bad");
        return;
      }
      removeSource(m);
      focusCanvas();
    },
    [gate.reason, focusCanvas, graph, removeSource, say],
  );
  // Delete and Backspace act only while focus is outside an editable
  // control (the panel's fields, the pane's search).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Escape clears the selection from anywhere on the page while no
    // dialog is open (as reference 13 does): the pane, the
    // panel, a tile, the frame's whisper.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // With focus inside the assistant pane the press is the pane's.
      if (assistantOwnsEscape(e.target)) return;
      if (document.querySelector("[data-dialog-host] [role='dialog']")) return;
      // Note mode leaves first, focus back on the tool; then the
      // selection, a note's or a member's, clears.
      if (notesCtl.keys.onEscape()) return;
      if (nodesRef.current.some((n) => n.selected)) deselect();
    };
    document.addEventListener("keydown", onEscape);
    const editable = (t: HTMLElement | null) => !!t && (!!t.closest("input, textarea, select, [contenteditable=\"true\"]") || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (editable(t)) return;
      // A note's keys first: N, Enter in note mode, Enter on a note, Delete
      // on a note; the members' keys follow.
      const selected = nodesRef.current.find((n) => n.selected);
      if (notesCtl.keys.onKey(e, t, selected)) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selected) return;
      const m = graph.members.find((x) => x.id === selected.id);
      if (!m) return;
      e.preventDefault();
      // Locked, the removal paths say the reason themselves.
      if (m.kind === "node") askRemoval(m);
      else tryRemoveSource(m);
    };
    host.addEventListener("keydown", onKey);
    return () => {
      host.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onEscape);
    };
  }, [askRemoval, deselect, graph, hostRef, nodesRef, notesCtl, tryRemoveSource]);

  // The stage's Arrange press: each press is one request.
  const arrange = () => setArrangeRequest((n) => n + 1);
  // The lock's own button. Locking leaves note mode and lets an open note
  // editor commit under its own rule (its blur); the picker closes on its
  // own.
  const toggleLock = () => {
    if (!lock.locked) {
      if (notesCtl.mode.on) notesCtl.mode.toggle();
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest("[data-note-field]")) active.blur();
    }
    lock.toggle();
  };
  // The removal question's close: never while the removal is on the wire.
  const closeRemoval = () => {
    if (!removing) setPendingRemoval(null);
  };

  return {
    gate,
    lock: { locked: lock.locked, toggle: toggleLock, unlock: lock.unlock },
    edits,
    sealRecord,
    onNodesChange,
    arrange,
    isValidConnection,
    onConnect,
    onConnectEnd,
    onReconnectStart,
    onReconnect,
    onReconnectEnd,
    deselect,
    selectMember,
    askRemoval,
    tryRemoveSource,
    removal: { pending: pendingRemoval, busy: removing, confirm: confirmRemoval, close: closeRemoval },
    addTool,
    addSource,
    isOverCanvas,
    notesCtl,
  };
}

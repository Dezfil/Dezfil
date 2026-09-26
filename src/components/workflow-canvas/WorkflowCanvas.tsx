"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  useStore,
  useViewport,
  type NodeChange,
} from "@xyflow/react";
import { BadgeNode } from "./BadgeNode";
import { CanvasMinimap } from "./CanvasMinimap";
import { CanvasNotices, type CanvasNotice } from "./CanvasNotices";
import { readMinimapChoice, writeMinimapChoice } from "./minimap-store";
import { CanvasPane } from "./CanvasPane";
import { CanvasFurniture, bandReserve, freeRectOf } from "./CanvasFurniture";
import { canvasHelperLayout, fitHelper } from "./assistant-layout";
import type { WorkflowAssistant } from "./WorkflowAssistantHost";
import { assistantOwnsEscape } from "../builder/assistant/escape-owner";
import { RemovalDialog } from "./RemovalDialog";
import { removalPlan, sourceKeptBecause } from "./removal-model";
import { CanvasStage } from "./CanvasStage";
import { CanvasSaveStatus } from "./CanvasSaveStatus";
import type { Whisper } from "./save-whisper";
import { ConnectionLine, ReadEdge } from "./ReadEdge";
import { SourceNode } from "./SourceNode";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { arrangeByDependency, GRID, NODE_H, NODE_W, type Positions } from "./arrange";
import { EditsContext } from "./edits-context";
import { RunActionsContext, RunContext, type RunActions } from "./run-context";
import { CanvasResults } from "./CanvasResults";
import { NoteNode } from "./NoteNode";
import { NoteMenu } from "./NoteMenu";
import { NoteActionsContext } from "./note-actions";
import { NOTE_TOOL_LIMIT, useCanvasNotes } from "./use-canvas-notes";
import { useCanvasHistory, type HistoryPorts } from "./use-canvas-history";
import type { LayoutName } from "./canvas-history";
import { useCanvasLinks } from "./use-canvas-links";
import { useCanvasLock } from "./use-canvas-lock";
import { useCanvasClipboard, type CopyAnswer } from "./use-canvas-clipboard";
import { usePageSelection } from "./use-page-selection";
import { writeClipboardItem, type ClipboardItem } from "./clipboard-items";
import type { WorkflowRunner } from "./use-workflow-run";

/** The panel's run actions: a node's own run
 * started here with its refusal kept per node; a run from a node handed
 * to the screen, which asks first when it is wide. */
function RunActionsProvider({
  runner,
  onRunFrom,
  children,
}: {
  runner: WorkflowRunner;
  onRunFrom: (from: { id: string; label: string }) => void;
  children: React.ReactNode;
}) {
  const [refusals, setRefusals] = useState<Record<string, { message: string; retry: (() => void) | null }>>({});
  const actions = useMemo<RunActions>(
    () => ({
      runNode: (m) => {
        // The refusal and its Retry are this owner's: Retry runs the node
        // again through here, so the notice follows the new answer.
        const attempt = () => {
          setRefusals((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== m.step.id)));
          void runner.runNode(m.step.id).then((outcome) => {
            if (outcome.kind === "refused") setRefusals((r) => ({ ...r, [m.step.id]: { message: outcome.message, retry: outcome.retryable ? attempt : null } }));
            else if (outcome.kind === "save_failed") setRefusals((r) => ({ ...r, [m.step.id]: { message: `Couldn't save the change, so nothing started. ${outcome.message}`, retry: null } }));
          });
        };
        attempt();
      },
      // The node as the canvas names it: its operation and its dataset.
      runFrom: (m) => onRunFrom({ id: m.step.id, label: m.outputName ? `${m.label} · ${m.outputName}` : m.label }),
      refusalFor: (stepId) => refusals[stepId] ?? null,
      dismissRefusal: (stepId) => setRefusals((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== stepId))),
    }),
    [onRunFrom, refusals, runner],
  );
  return <RunActionsContext.Provider value={actions}>{children}</RunActionsContext.Provider>;
}
import type { RecipeCoordinator } from "./use-recipe-edits";
import { defaultOutputName, initialParameters, registeredName } from "../builder/drawer/operation-form";
import { acceptsClass, expectedClass, outputNameOf } from "./link-rules";
import type { DropPoint } from "./CanvasPane";
import type { CanvasGraph, NodeMember, SourceMember } from "./graph";
import { effectiveParameters } from "./graph";
import { initialPositions, type LayoutNote, type LayoutRead } from "./placement";
import { reconcileNodes } from "./reconcile-nodes";
import { nudgeDiagonal, nudgeFree, screenPositions, unechoedPlacements } from "./screen-positions";
import {
  flowEdges,
  flowNodes,
  isMemberNode,
  isNoteNode,
  NOTE_A11Y_ID,
  noteFlowNode,
  noteNodeId,
  type FlowNode,
  type NoteFlowNode,
  type ReadFlowEdge,
} from "./to-flow";
import { useLayoutSaves, type LayoutSnapshot, type SaveState } from "./use-layout-saves";
import { FAR_ZOOM, MAX_ZOOM, MINIMAP_AT, MIN_ZOOM, fitOptions } from "./view";
import { CanvasGrid } from "./CanvasGrid";
import styles from "./WorkflowCanvas.module.css";

/**
 * The canvas, reading: the graph on screen, navigable and arrangeable,
 * the recipe untouched. The library is configured read-only for the
 * recipe and open for arrangement: members drag by pointer and keyboard;
 * nothing connects, reconnects, multi-selects or deletes; edges are not
 * focusable; its stock instructions about linking and deleting are
 * replaced. A layout write happens only when a move completes or on
 * Arrange: the library's own mount, measure and selection
 * changes never reach the coordinator. Loaded on the workflow page only.
 */

const NODE_TYPES = { badge: BadgeNode, source: SourceNode, note: NoteNode };
const EDGE_TYPES = { read: ReadEdge };
const ARIA = {
  "node.a11yDescription.default":
    "Press Enter or Space to select. The arrow keys move a selected node; Escape clears the selection.",
  "node.a11yDescription.keyboardDisabled": "Press Enter or Space to select.",
  "node.a11yDescription.ariaLiveMessage": ({
    direction,
    x,
    y,
  }: {
    direction: string;
    x: number;
    y: number;
  }) => `Moved ${direction} to ${Math.round(x)}, ${Math.round(y)}.`,
  "edge.a11yDescription.default": "",
  "handle.ariaLabel": "Port",
} as const;

export interface WorkflowCanvasProps {
  id: string;
  graph: CanvasGraph;
  layout: LayoutRead;
  tables: TableListing[];
  operations: OperationDef[];
  onSaveState: (state: SaveState) => void;
  /** The frame's whisper for the recipe: a failed undo offers Retry through it, as any edit's failure does. */
  onEditState: (state: SaveState) => void;
  /** The record's two buttons live in the workspace header beside the
   * theme toggle, as the builder's do (word after, -08-29); the canvas
   * tells the screen what they should read and hands it the press. */
  onHistory: (state: HistoryChrome) => void;
  /** The layout as stored after a write; the screen keeps it live. */
  onLayoutWritten: (layout: LayoutRead) => void;
  /** The recipe-edit coordinator, for the pane and the panels. */
  edits: RecipeCoordinator;
  /** The pane's Add data: the screen opens the workspace's dialog. */
  onAddData: () => void;
  /** A table the dialog brought in, to place as a loose source; the
   * sequence tells one import from the next. */
  addSourceRequest: { names: string[]; seq: number } | null;
  /** The workflow's runs, for the panel's Run section and the guards. */
  runner: WorkflowRunner;
  /** Run from a node: the screen asks first when the run is wide. */
  onRunFrom: (from: { id: string; label: string }) => void;
  /** The results band found a dataset the listing still held gone: the
   * screen re-reads the listing. */
  onListingStale: () => void;
  /** The screen's owner-keyed save whisper: the canvas draws
   * it on its own stage; every owner, timer and rule stays the
   * screen's. */
  whisper: Whisper | null;
  /** The assistant: the screen owns its door; the canvas decides what an open pane does here and mounts it. */
  assistant: WorkflowAssistant;
  recipeName: string;
}

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

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <RunContext.Provider value={props.runner}>
        <RunActionsProvider runner={props.runner} onRunFrom={props.onRunFrom}>
          <Canvas {...props} />
        </RunActionsProvider>
      </RunContext.Provider>
    </ReactFlowProvider>
  );
}

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Canvas({
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
  onAddData,
  addSourceRequest,
  runner,
  onListingStale,
  whisper,
  assistant,
  recipeName,
}: WorkflowCanvasProps) {
  const flow = useReactFlow<FlowNode, ReadFlowEdge>();
  const [view, setView] = useState<"full" | "framed">("full");
  // The canvas lock: this page's way of looking.
  const lock = useCanvasLock();
  // A transient notice at the canvas's foot: a refusal's reason, a link made.
  // It stands before the coordinators because their Retry ports speak here.
  const [notice, setNotice] = useState<CanvasNotice | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const say = useCallback((text: string, tone?: "bad", hold = false) => {
    setNotice({ text, tone });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    // A held notice (note mode's) stays until it is cleared.
    if (!hold) noticeTimer.current = window.setTimeout(() => setNotice(null), tone === "bad" ? 5200 : 3200);
  }, []);
  const hush = useCallback(() => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(null);
  }, []);
  const readLockReason = useCallback(() => lock.reason, [lock.reason]);
  // This page's record of its own steps. Its ports are filled by the
  // commit below, so the record can stand before the screen's own
  // callbacks exist, as the edit coordinator's are.
  const historyPorts = useRef<HistoryPorts | null>(null);
  // The minimap: spec rule (from six members) until the viewer chooses by
  // the stage button, then their choice in every workflow (the browser's,
  // never the server's). The button always toggles what is on the screen,
  // so a press under six members shows the map rather than recording a
  // choice nothing displays.
  const [minimapChoice, setMinimapChoice] = useState(readMinimapChoice);
  const minimapShown = minimapChoice ? minimapChoice === "shown" : graph.members.length >= MINIMAP_AT;
  const toggleMinimap = useCallback(() => {
    const next = minimapShown ? "hidden" : "shown";
    writeMinimapChoice(next);
    setMinimapChoice(next);
  }, [minimapShown]);
  const history = useCanvasHistory({ id, edits: rawEdits, graph, operations, ports: historyPorts });
  useEffect(() => {
    rawEdits.setRetryPorts({ lockReason: readLockReason, say });
  }, [rawEdits, readLockReason, say]);
  const historyPress = history.press;
  const historySeal = history.seal;
  useEffect(() => {
    onHistory({ canUndo: history.canUndo, canRedo: history.canRedo, reason: lock.reason, press: historyPress, seal: historySeal });
  }, [onHistory, history.canUndo, history.canRedo, lock.reason, historyPress, historySeal]);
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
  /** A member to select on its first reconciliation (a paste): state, since the reconciliation runs in render. */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  /** This page's copy chain: what was copied, every paste of it, and the
   * item's own text, so an item from elsewhere never rides its diagonal. */
  const copyChain = useRef<{ from: string | null; pasted: Set<string>; last: string | null; key: string | null }>({ from: null, pasted: new Set(), last: null, key: null });
  /** Names and spots handed to pastes not read back yet (the spots by the
   * pasted step's id, held until the graph shows it): rapid pastes never collide. */
  const reserved = useRef<{ names: Set<string>; spots: Positions }>({ names: new Set(), spots: {} });
  // Full view dissolves the header bar over the surface, as the builder's
  // fullscreen map does with its own attribute.
  useEffect(() => {
    if (view !== "full") return;
    document.body.setAttribute("data-canvas-full", "");
    return () => document.body.removeAttribute("data-canvas-full");
  }, [view]);
  // The results band's column takes its room at the screen's foot in full
  // view: the overlays and the fit keep above it. In framed view the card
  // above it is the flow area itself.
  const [bandHeight, setBandHeight] = useState(0);
  const [hostHeight, setHostHeight] = useState(600);
  const reserve = bandReserve(view, bandHeight);
  // For the fits that run outside render (Arrange's, the toggle's, an
  // Arrange undone).
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const reserveRef = useRef(reserve);
  useEffect(() => {
    reserveRef.current = reserve;
  }, [reserve]);
  // Far zoom follows the viewport itself, whatever moved it — a gesture,
  // the stack, fit, the minimap — not the library's gesture events.
  const { zoom } = useViewport();
  const lod = zoom < FAR_ZOOM ? "far" : "near";
  const [animating, setAnimating] = useState(false);
  // The notes are in the first nodes too, so the first fit takes them
  // into its bounds with the members.
  const initial = useMemo(
    () => [...layout.notes.map((n, i) => noteFlowNode(n, false, i)), ...flowNodes(graph, initialPositions(graph, layout))],
    [graph, layout],
  );
  const [nodes, setNodes] = useState<FlowNode[]>(initial);
  // Whether a panel is open, for the fits that run outside render.
  const hasPanel = useRef(false);
  const selectedMember = useMemo(() => {
    const id = nodes.find((n) => n.selected)?.id;
    return id ? (graph.members.find((m) => m.id === id) ?? null) : null;
  }, [graph, nodes]);
  useEffect(() => {
    hasPanel.current = selectedMember !== null;
  }, [selectedMember]);
  // What an open assistant pane does here; the fits read the visible furniture.
  const helperLayout = canvasHelperLayout({ view, band: assistant.band, paneOpen: assistant.open, panelUp: selectedMember !== null });
  const { panel: fitPanel, helperRight } = fitHelper(helperLayout, assistant.open, selectedMember !== null);
  const helperRightRef = useRef(helperRight);
  const fitPanelRef = useRef(fitPanel);
  useEffect(() => { helperRightRef.current = helperRight; fitPanelRef.current = fitPanel; }, [helperRight, fitPanel]);
  const edges = useMemo<ReadFlowEdge[]>(() => flowEdges(graph, null, lock.locked), [graph, lock.locked]);
  const { save, placeSource, dropSource, dropStep, restore, pending: writesPending } = useLayoutSaves({
    id,
    layout,
    graph,
    onState: onSaveState,
    onWritten: onLayoutWritten,
    lockReason: readLockReason,
    say,
  });

  // The live graph comes and goes under the canvas (a node added, removed,
  // a source that a read now needs): members the canvas already shows keep
  // their positions; new ones take the layout's or a place beside the
  // graph; gone ones leave. Adjusted during render, as React has state
  // follow a prop; nothing here writes.
  const [placements, setPlacements] = useState<Positions>({});
  const placementsRef = useRef<Positions>(placements);
  const [seen, setSeen] = useState<{ graph: CanvasGraph; layout: LayoutRead }>({ graph, layout });
  if (seen.graph !== graph || seen.layout !== layout) {
    setSeen({ graph, layout });
    // A pasted node is selected once it exists; the selection is
    // honoured once, then let go.
    const select = pendingSelect && graph.members.some((m) => m.id === pendingSelect) ? pendingSelect : null;
    const next = reconcileNodes(nodes, graph, layout, placements, select);
    if (select) setPendingSelect(null);
    if (next) setNodes(next);
    // A placement the read has echoed is the tile's own now and is
    // forgotten, so a member removed elsewhere later leaves no phantom
    // position behind in the snapshots (found at review).
    const waiting = unechoedPlacements(placements, (id) => graph.members.some((m) => m.id === id));
    if (waiting !== placements) setPlacements(waiting);
  }

  // A completed move — a pointer drag's end or an arrow key's step — is a
  // position change that is not dragging; the many that arrive together
  // (a drag's last batch, a held key) become one write.
  const pending = useRef<number | null>(null);
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    placementsRef.current = placements;
  }, [placements]);
  /** Every member's position as the screen holds it: the tiles it shows,
   * over a placement no read has echoed yet — a source just placed, a
   * node just added or just brought back. The record must read the same
   * screen the user sees, or an undo taken in that window finds the
   * member already gone ((d) and 3(f)); `gone` leaves out a member on its
   * way off the canvas. */
  const screenNow = useCallback((gone?: string) => screenPositions(nodesRef.current, placementsRef.current, gone), []);
  // The notes as they are now: every write carries them with the
  // positions, so a note changed while a write is in flight rides the
  // next, and Retry sends the newest. The notes hook keeps this current.
  const notesRef = useRef<LayoutNote[]>(layout.notes);
  const snapshotOf = useCallback((positions: Positions): LayoutSnapshot => ({ positions, notes: notesRef.current }), []);
  // After every graph change the library re-measures each member's handles:
  // a node rebuilt for a re-read can otherwise keep its size and lose its
  // handle bounds, and an edge into it stays undrawn (seen once in three
  // runs of the editing journey).
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    // Members alone: their handles move with the graph. A note has none,
    // and its id is the writer's own (any nonblank string), which must
    // never reach the library's selector-based lookup (found at review).
    updateNodeInternals(nodesRef.current.filter(isMemberNode).map((n) => n.id));
  }, [graph, updateNodeInternals]);
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
    [saveSoon],
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
  const hostRef = useRef<HTMLDivElement>(null);

  // The view toggle changes only the frame (ver re-fit): the flow area's
  // origin moves between the views, and once the library has measured the
  // container at its new size the viewport moves the other way by the
  // same amount, so every tile stays under the same pixels at the same
  // zoom. It still writes nothing. A layout effect, so the correction
  // lands in the same frame as the library's measure and no frame paints
  // the old transform at the new origin (found at review).
  const shift = useRef<{ left: number; top: number } | null>(null);
  /** The flow area's origin on the screen: its padding box, since the
   * framed card's border is outside the library's pane. */
  const origin = useCallback(() => {
    const el = hostRef.current?.querySelector<HTMLElement>("[data-flow-area]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left + el.clientLeft, top: r.top + el.clientTop };
  }, []);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useLayoutEffect(() => {
    const from = shift.current;
    if (!from || width === 0 || height === 0) return;
    shift.current = null;
    const to = origin();
    if (!to) return;
    const vp = flow.getViewport();
    void flow.setViewport({ x: vp.x - (to.left - from.left), y: vp.y - (to.top - from.top), zoom: vp.zoom });
  }, [flow, height, origin, width]);
  const onView = useCallback(
    (next: "full" | "framed") => {
      shift.current = origin();
      setView(next);
    },
    [origin],
  );
  /** The screen rect of the canvas the pane does not cover. */
  const freeRect = useCallback(() => (hostRef.current ? freeRectOf(hostRef.current) : null), []);
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
    [offerLayout, placedAt, reveal, save, screenNow, snapshotOf],
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
    [offerLayout, placeAt, placeSource, reveal, screenNow, snapshotOf],
  );
  // Several tables from one import (a container) each take their own spot.
  const addSources = useCallback(
    (names: string[]) => {
      if (lock.reason) {
        say(lock.reason, "bad");
        return;
      }
      const given: Positions = {};
      for (const name of names) given[`src:${name.trim().toLowerCase()}`] = addSource(name, null, given);
    },
    [addSource, lock.reason, say],
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
  const deselect = useCallback(() => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n))), []);
  const selectMember = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      const target = nodesRef.current.find((n) => n.id === id);
      if (target) void flow.setCenter(target.position.x + NODE_W / 2, target.position.y + NODE_H / 2, { zoom: flow.getZoom(), duration: 240 });
    },
    [flow],
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
    [deselect, dropSource, offerLayout, screenNow, snapshotOf],
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
  }, []);

  // notes: the coordinator beside the canvas ----
  const focusNoteNode = useCallback((id: string) => {
    // The id is the writer's own: escaped, so a quote in it cannot break
    // the selector (found at review).
    hostRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(noteNodeId(id))}"]`)?.focus();
  }, []);
  const focusNoteTool = useCallback(() => {
    hostRef.current?.querySelector<HTMLElement>("[data-note-tool]")?.focus();
  }, []);
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
  const notesCtl = useCanvasNotes({ layout, flow, write: writeNotes, say, hush, deselect, focusCanvas, focusTool: focusNoteTool, focusNote: focusNoteNode, freeRect, writesPending, lockReason: lock.reason });
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
  const positionOf = useCallback((id: string) => nodesRef.current.find((n) => n.id === id)?.position ?? null, []);
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
  }, []);
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
  }, [flow]);
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
    [dropStep, offerLayout, screenNow, snapshotOf],
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
      lockReason: lock.reason,
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
  // The notes join the members whenever the coordinator's view of them
  // changes (adjusted during render, as the members are).
  const [seenWithNotes, setSeenWithNotes] = useState<typeof notesCtl.withNotes | null>(null);
  if (seenWithNotes !== notesCtl.withNotes) {
    const merge = notesCtl.withNotes;
    setSeenWithNotes(() => merge);
    setNodes((ns) => merge(ns));
    if (notesCtl.pendingSelect) notesCtl.consumeSelection();
  }
  // Under manual stacking a selected member lifts by hand; a note never
  // leaves its layer. ---- copy and paste ----
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
    const item: ClipboardItem = { kind: "node", operation: m.step.operation, parameters: draft ? { ...draft.values } : effectiveParameters(m.step) };
    copyChain.current = { from: m.id, pasted: new Set(), last: null, key: writeClipboardItem(item) };
    return { item, said: `Copied ${m.label}.` };
  }, [graph, runner]);
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
        const refusal = await edits.add({ operation: item.operation, parameters: item.parameters });
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
      const outcome = await edits.add({ operation: op.id, parameters: { ...item.parameters, name } }, { pasted: true });
      delete held.spots[spotKey];
      if (outcome.kind !== "accepted" || !outcome.step) {
        held.names.delete(name);
        if (outcome.kind === "refused") say(outcome.message, "bad");
        return;
      }
      const id = outcome.step.id;
      held.spots[id] = position;
      chain.pasted.add(id);
      chain.last = id;
      setPendingSelect(id);
      placeAdded(id, position);
      say(`Pasted ${op.label} as ${name}.`);
    },
    [edits, graph, notesCtl, operations, placeAdded, placeAt, say, screenNow, tables],
  );
  useCanvasClipboard({ host: hostRef, copy: copyItem, paste: (item) => void pasteItem(item), say, lockReason: lock.reason });

  // Locked, every member stands still and links nothing: the flags are
  // per node, over the ones the mapping set.
  const stacked = useMemo(() => {
    const list = notesCtl.elevated(nodes);
    return lock.locked ? list.map((n) => ({ ...n, draggable: false, connectable: false })) : list;
  }, [lock.locked, nodes, notesCtl]);
  // The ghost and the note menu, the canvas's overlays in the flow area's
  // own coordinates, following the viewport.
  const flowDom = useStore((s) => s.domNode);
  const viewport = useViewport();
  const selectedNote = nodes.find((n): n is NoteFlowNode => isNoteNode(n) && !!n.selected && !n.data.editing) ?? null;
  const overlays = (() => {
    if (!flowDom) return null;
    void viewport;
    const box = flowDom.getBoundingClientRect();
    const toArea = (x: number, y: number) => {
      const s = flow.flowToScreenPosition({ x, y });
      return { x: s.x - box.left, y: s.y - box.top };
    };
    const g = notesCtl.mode.ghost;
    let ghost: React.ReactNode = null;
    if (g) {
      const a = toArea(g.x, g.y);
      const b = toArea(g.x + g.w, g.y + g.h);
      ghost = <div className={styles.noteGhost} data-note-ghost style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }} aria-hidden="true" />;
    }
    let menu: React.ReactNode = null;
    if (selectedNote) {
      const n = selectedNote.data.note;
      const a = toArea(selectedNote.position.x, selectedNote.position.y);
      const b = toArea(selectedNote.position.x + (selectedNote.measured?.width ?? n.w), selectedNote.position.y + (selectedNote.measured?.height ?? n.h));
      // Clamped within the drawable area, in the flow area's coordinates
      // (read off the library's element, not a ref: this runs in render).
      const hostEl = flowDom.closest<HTMLElement>("[data-workflow-canvas]");
      const free = hostEl ? freeRectOf(hostEl) : null;
      const bounds = free
        ? { left: free.left - box.left, top: free.top - box.top, right: free.right - box.left, bottom: free.bottom - box.top }
        : { left: 0, top: 0, right: box.width, bottom: box.height };
      // A selected note keeps its selection without its menu while locked.
      if (!lock.locked) menu = <NoteMenu note={n} anchor={{ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }} bounds={bounds} actions={notesCtl.actions} />;
    }
    return (
      <>
        {ghost}
        {menu}
      </>
    );
  })();
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
      if (lock.reason) {
        say(lock.reason, "bad");
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
    [lock.reason, runner, say],
  );
  // A confirmation open on a member that becomes unsettled is dismissed
  // (adjusted during render, as the graph's re-read brings the run's word).
  if (pendingRemoval && runner.unsettled(pendingRemoval.step.id)) setPendingRemoval(null);
  const tryRemoveSource = useCallback(
    (m: SourceMember) => {
      const why = lock.reason ?? sourceKeptBecause(m, graph);
      if (why) {
        say(why, "bad");
        return;
      }
      removeSource(m);
      focusCanvas();
    },
    [lock.reason, focusCanvas, graph, removeSource, say],
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
  }, [askRemoval, deselect, graph, notesCtl, tryRemoveSource]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHostHeight(el.clientHeight));
    observer.observe(el);
    setHostHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const empty = graph.members.length === 0 && notesCtl.notes.length === 0;
  // The page's text selection: Cmd/Ctrl+A with the canvas owning the key
  // selects nothing, and a press on the canvas clears a selection swept
  // elsewhere on the page.
  const clearSelectionOnPress = usePageSelection();

  return (
    <EditsContext.Provider value={edits}>
    <div
      ref={hostRef}
      className={styles.host}
      data-view={view}
      data-lod={lod}
      data-animating={animating || undefined}
      data-panel={selectedMember ? selectedMember.kind : undefined}
      data-mode={notesCtl.mode.on ? "note" : undefined}
      data-locked={lock.locked || undefined}
      style={{ "--band-h": `${reserve}px`, "--assistant-right": `${helperLayout.hostRight}px`, "--band-right": `${helperLayout.bandRight}px` } as React.CSSProperties}
      data-workflow-canvas
    >
      <span id={NOTE_A11Y_ID} hidden>
        A note. Press Enter to write, the arrow keys to move, Delete to remove.
      </span>
      {/* The library sizes its root at 100% of its parent with inline
          styles, so the area it fills is this box: the whole host in full
          view, the card right of the docked pane in framed. */}
      <div
        className={styles.flowArea}
        tabIndex={-1}
        data-flow-area
        onPointerDownCapture={(e) => {
          clearSelectionOnPress(e);
          sealRecord();
        }}
        {...notesCtl.pane}
      >
        <NoteActionsContext.Provider value={notesCtl.actions}>
        <ReactFlow<FlowNode, ReadFlowEdge>
          className={styles.flow}
          nodes={stacked}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          connectionLineComponent={ConnectionLine}
          fitView
          fitViewOptions={fitOptions(view, fitPanel, reserve, helperRight)}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          snapToGrid
          snapGrid={[GRID, GRID]}
          nodesDraggable={!lock.locked}
          nodesConnectable={!lock.locked}
          edgesFocusable={false}
          edgesReconnectable={!lock.locked}
          isValidConnection={isValidConnection}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onReconnectStart={onReconnectStart}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          connectionRadius={24}
          reconnectRadius={24}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionOnDrag={false}
          panOnDrag={!notesCtl.mode.on}
          zIndexMode="manual"
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={ARIA}
          aria-label="Workflow canvas"
        >
          <CanvasGrid />
        </ReactFlow>
        </NoteActionsContext.Provider>
        {overlays}
        <CanvasFurniture
          selected={selectedMember}
          graph={graph}
          operations={operations}
          tables={tables}
          layout={helperLayout}
          lockReason={lock.reason}
          onClose={deselect}
          onRemove={askRemoval}
          onSelect={selectMember}
          onRemoveSource={tryRemoveSource}
          assistant={assistant}
          recipe={{ id, name: recipeName }}
          runner={runner.state}
        />
        <CanvasStage
          view={view}
          onView={onView}
          panel={fitPanel}
          reserve={reserve}
          helperRight={helperRight}
          onArrange={() => setArrangeRequest((n) => n + 1)}
          canArrange={graph.members.length > 0}
          arrangeReason={lock.reason}
          noteMode={notesCtl.mode.on}
          noteToolReason={lock.reason ?? (notesCtl.canAdd() ? null : NOTE_TOOL_LIMIT)}
          onNoteTool={notesCtl.mode.toggle}
          minimapShown={minimapShown}
          onMinimap={toggleMinimap}
          locked={lock.locked}
          onLock={() => {
            // Locking leaves note mode and lets an open note editor commit
            // under its own rule (its blur); the picker closes on its own.
            if (!lock.locked) {
              if (notesCtl.mode.on) notesCtl.mode.toggle();
              (document.activeElement as HTMLElement | null)?.closest("[data-note-field]") && (document.activeElement as HTMLElement).blur();
            }
            lock.toggle();
          }}
        />
        <CanvasSaveStatus whisper={whisper} />
        <CanvasNotices notice={notice} locked={lock.locked} onUnlock={lock.unlock} />
        {minimapShown ? <CanvasMinimap edges={graph.edges} /> : null}
        {empty ? (
          <p className={styles.emptyNote}>
            <b>No nodes yet</b>
            This workflow is empty.
          </p>
        ) : null}
      </div>
      <CanvasPane
        graph={graph}
        tables={tables}
        operations={operations}
        onAddTool={(op, at) => void addTool(op, at)}
        onAddSource={addSource}
        onAddData={onAddData}
        isOverCanvas={isOverCanvas}
        lockReason={lock.reason}
      />
      <CanvasResults
        graph={graph}
        selected={selectedMember}
        tables={tables}
        operations={operations}
        runner={runner}
        hostHeight={hostHeight}
        onHeight={setBandHeight}
        onSelectNode={selectMember}
        onListingStale={onListingStale}
      />

      {pendingRemoval ? (
        <RemovalDialog
          member={pendingRemoval}
          plan={removalPlan(pendingRemoval, graph, tables)}
          busy={removing}
          onConfirm={() => void confirmRemoval()}
          onClose={() => {
            if (!removing) setPendingRemoval(null);
          }}
        />
      ) : null}
    </div>
    </EditsContext.Provider>
  );
}

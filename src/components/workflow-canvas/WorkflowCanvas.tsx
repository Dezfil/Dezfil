"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  useStore,
  useViewport,
} from "@xyflow/react";
import { CanvasMinimap } from "./CanvasMinimap";
import { CanvasNotices, type CanvasNotice } from "./CanvasNotices";
import { useCanvasOpening } from "./canvas-opening";
import { CanvasPane } from "./CanvasPane";
import { CanvasFurniture, bandReserve, freeRectOf } from "./CanvasFurniture";
import { canvasHelperLayout, fitHelper } from "./assistant-layout";
import type { WorkflowAssistant } from "./WorkflowAssistantHost";
import { RemovalDialog } from "./RemovalDialog";
import { removalPlan } from "./removal-model";
import { WorkflowStage } from "./WorkflowStage";
import { CanvasStage } from "./CanvasStage";
import type { Whisper } from "./save-whisper";
import type { OperationDef } from "@/lib/operations/catalog";
import type { TableListing } from "../api";
import { type Positions } from "./arrange";
import { EditsContext } from "./edits-context";
import { RunContext } from "./run-context";
import { RunActionsProvider } from "./RunActionsProvider";
import { CanvasResults } from "./CanvasResults";
import { NoteMenu } from "./NoteMenu";
import { NOTE_TOOL_LIMIT } from "./use-canvas-notes";
import { useCanvasEditing, type HistoryChrome } from "./use-canvas-editing";
import { usePageSelection } from "./use-page-selection";
import type { WorkflowRunner } from "./use-workflow-run";
import type { RecipeCoordinator } from "./use-recipe-edits";
import type { CanvasGraph } from "./graph";
import { initialPositions, type LayoutRead } from "./placement";
import { reconcileNodes } from "./reconcile-nodes";
import { unechoedPlacements } from "./screen-positions";
import {
  flowEdges,
  flowNodes,
  isMemberNode,
  isNoteNode,
  NOTE_A11Y_ID,
  noteFlowNode,
  type FlowNode,
  type NoteFlowNode,
  type ReadFlowEdge,
} from "./to-flow";
import type { SaveState } from "./use-layout-saves";
import { FAR_ZOOM } from "./view";
import styles from "./WorkflowCanvas.module.css";

export type { HistoryChrome };

/**
 * The canvas, reading: the graph on screen, navigable and arrangeable,
 * the recipe untouched. The library is configured read-only for the
 * recipe and open for arrangement: members drag by pointer and keyboard;
 * nothing connects, reconnects, multi-selects or deletes; edges are not
 * focusable; its stock instructions about linking and deleting are
 * replaced. A layout write happens only when a move completes or on
 * Arrange: the library's own mount, measure and selection
 * changes never reach the coordinator. Loaded on the workflow page only.
 * This module draws; the interaction and edit wiring lives beside it in
 * use-canvas-editing.ts, behind the one gate the editing flags read.
 */

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
  // Full screen or framed, and the minimap until the viewer chose by the
  // stage button: as the instance's defaults say (canvas-opening.ts).
  const { view, setView, minimapShown, toggleMinimap } = useCanvasOpening(graph.members.length);
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
  /** A member to select on its first reconciliation (a paste): state, since the reconciliation runs in render. */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
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
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    placementsRef.current = placements;
  }, [placements]);
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

  // The canvas host: the pane's adds, the notes' focus and the keys measure and listen here.
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
    [origin, setView],
  );

  // Moving, adding, linking, selecting, removing, the keys that mutate,
  // copy and paste, the notes coordinator and the record's ports: the
  // canvas's edit wiring (use-canvas-editing.ts), behind one gate.
  const editing = useCanvasEditing({
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
  });
  const {
    gate, lock, notesCtl, edits, sealRecord, onNodesChange, arrange,
    isValidConnection, onConnect, onConnectEnd, onReconnectStart, onReconnect, onReconnectEnd,
    deselect, selectMember, askRemoval, tryRemoveSource, removal, addTool, addSource, isOverCanvas,
  } = editing;
  const edges = useMemo<ReadFlowEdge[]>(() => flowEdges(graph, null, gate.locked), [graph, gate.locked]);
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
  // leaves its layer. Locked, every member stands still and links
  // nothing: the flags are per node, over the ones the mapping set.
  const stacked = useMemo(() => {
    const list = notesCtl.elevated(nodes);
    return gate.locked ? list.map((n) => ({ ...n, draggable: false, connectable: false })) : list;
  }, [gate.locked, nodes, notesCtl]);
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
      if (!gate.locked) menu = <NoteMenu note={n} anchor={{ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }} bounds={bounds} actions={notesCtl.actions} />;
    }
    return (
      <>
        {ghost}
        {menu}
      </>
    );
  })();

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
      data-locked={gate.locked || undefined}
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
        <WorkflowStage
          nodes={stacked} edges={edges} onNodesChange={onNodesChange}
          view={view} panel={fitPanel} reserve={reserve} helperRight={helperRight}
          locked={gate.locked} noteMode={notesCtl.mode.on} noteActions={notesCtl.actions}
          isValidConnection={isValidConnection} onConnect={onConnect} onConnectEnd={onConnectEnd}
          onReconnectStart={onReconnectStart} onReconnect={onReconnect} onReconnectEnd={onReconnectEnd}
          whisper={whisper}
        >
        {overlays}
        <CanvasFurniture
          selected={selectedMember}
          graph={graph}
          operations={operations}
          tables={tables}
          layout={helperLayout}
          lockReason={gate.reason}
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
          onArrange={arrange}
          canArrange={graph.members.length > 0}
          arrangeReason={gate.reason}
          noteMode={notesCtl.mode.on}
          noteToolReason={gate.reason ?? (notesCtl.canAdd() ? null : NOTE_TOOL_LIMIT)}
          onNoteTool={notesCtl.mode.toggle}
          minimapShown={minimapShown}
          onMinimap={toggleMinimap}
          locked={lock.locked}
          onLock={lock.toggle}
        />
        </WorkflowStage>
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
        lockReason={gate.reason}
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

      {removal.pending ? (
        <RemovalDialog
          member={removal.pending}
          plan={removalPlan(removal.pending, graph, tables)}
          busy={removal.busy}
          onConfirm={() => void removal.confirm()}
          onClose={removal.close}
        />
      ) : null}
    </div>
    </EditsContext.Provider>
  );
}

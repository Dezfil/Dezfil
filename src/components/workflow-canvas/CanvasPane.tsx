"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useNodes, useReactFlow } from "@xyflow/react";
import type { OperationDef } from "@/lib/operations/catalog";
import { formatCount, type TableListing } from "../api";
import { groupTables } from "../builder/drawer/derived-tables";
import { geometryGlyphType } from "../geometry-class";
import { DatabaseIcon, PlusIcon, SearchIcon } from "../ui/icons";
import { TabPanel, Tabs } from "../ui/Tabs";
import { GeometryGlyph, OperationGlyph, ToolsIcon } from "../ui/operation-icons";
import { normalName, sourceId } from "../workflow-producers";
import { NODE_H, NODE_W } from "./arrange";
import type { CanvasGraph } from "./graph";
import type { FlowNode } from "./to-flow";
import { useViewOnly } from "./view-only";
import styles from "./WorkflowCanvas.module.css";
import { useHeaderReach } from "../shell/use-header-reach";

/**
 * The pane: Sources and Tools, each with a count and its own search. A
 * Tools row adds a node — a click places it in the visible canvas, a drag
 * where it lands; a Sources row adds a loose source the same way, and one
 * already on the canvas centres the view instead. A tool unavailable on
 * this instance says why and cannot be added. Add data opens the
 * workspace's dialog.
 */

const GROUP_ORDER = ["Data", "Overlay", "Proximity", "Geometry", "Aggregation", "Statistics"];
/** A press moves this far before it is a drag rather than a click. */
const DRAG_THRESHOLD = 6;

export type DropPoint = { x: number; y: number } | null;

export function CanvasPane({
  graph,
  tables,
  operations,
  onAddTool,
  onAddSource,
  onAddData,
  isOverCanvas,
  lockReason = null,
}: {
  graph: CanvasGraph;
  tables: TableListing[];
  operations: OperationDef[];
  /** Add a node: at the screen point it was dropped, or in view (null). */
  onAddTool: (operation: OperationDef, at: DropPoint) => void;
  /** Add a loose source the same way. */
  onAddSource: (name: string, at: DropPoint) => void;
  onAddData: () => void;
  /** Whether a screen point lies on the free canvas (outside this pane). */
  isOverCanvas: (x: number, y: number) => boolean;
  /** The canvas lock's reason while locked: rows, drops and Add data are inert with it. */
  lockReason?: string | null;
}) {
  const [tab, setTab] = useState<"sources" | "tools">("sources");
  // A Viewer's pane lists and finds; it adds nothing, so neither the lock's
  // banner nor Add data is drawn.
  const viewOnly = useViewOnly();
  // The header card reaches this pane's right edge, as the builder's
  // card reaches the layer pane's.
  const paneRef = useRef<HTMLElement>(null);
  useHeaderReach(() => paneRef.current);
  // Each tab keeps its own search: a filter typed for
  // sources must not empty the tools.
  const [queries, setQueries] = useState({ sources: "", tools: "" });
  const query = queries[tab];
  const setQuery = (value: string) => setQueries((q) => ({ ...q, [tab]: value }));
  const flow = useReactFlow<FlowNode>();
  const nodes = useNodes<FlowNode>();

  const liveOutputs = useMemo(
    () => new Set(graph.members.flatMap((m) => (m.kind === "node" && m.step.output ? [m.step.output.id] : []))),
    [graph],
  );
  const onCanvas = useMemo(
    () => new Set(graph.members.flatMap((m) => (m.kind === "source" ? [normalName(m.name)] : []))),
    [graph],
  );
  const listed = useMemo(() => tables.filter((t) => !liveOutputs.has(t.id)), [liveOutputs, tables]);
  const sq = queries.sources.trim().toLowerCase();
  const tq = queries.tools.trim().toLowerCase();
  // The reference's order: the workspace's tables first, the other
  // workflows' outputs after (keeps the groups' names).
  const groups = useMemo(() => {
    const order = ["workspace", "outputs", "sketches"];
    return groupTables(
      listed.filter((t) => !sq || t.name.toLowerCase().includes(sq)),
      [],
    ).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }, [listed, sq]);
  const tools = useMemo(() => {
    const byGroup = new Map<string, OperationDef[]>();
    for (const op of operations) {
      if (tq && !op.label.toLowerCase().includes(tq) && !op.blurb.toLowerCase().includes(tq)) continue;
      const list = byGroup.get(op.group) ?? [];
      list.push(op);
      byGroup.set(op.group, list);
    }
    const order = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i === -1 ? GROUP_ORDER.length : i;
    };
    return [...byGroup.entries()].sort((a, b) => order(a[0]) - order(b[0]));
  }, [operations, tq]);

  const centreOn = (name: string) => {
    const id = sourceId(name);
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    // Centre at the zoom the user has, not the library's maximum.
    void flow.setCenter(
      n.position.x + (n.measured?.width ?? NODE_W) / 2,
      n.position.y + (n.measured?.height ?? NODE_H) / 2,
      { zoom: flow.getZoom(), duration: 240 },
    );
  };

  // The drag: a press that moves past the threshold carries a ghost and
  // drops on the free canvas; a press that does not is a click.
  const drag = useRef<{ kind: "tool" | "table"; key: string; x: number; y: number; moved: boolean; label: string } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const press = (e: ReactPointerEvent<HTMLElement>, kind: "tool" | "table", key: string, label: string) => {
    if (e.button !== 0) return;
    if (lockReason && !(kind === "table" && onCanvas.has(normalName(key)))) return;
    drag.current = { kind, key, x: e.clientX, y: e.clientY, moved: false, label };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < DRAG_THRESHOLD) return;
    d.moved = true;
    setGhost({ x: e.clientX, y: e.clientY, label: d.label });
  };
  const release = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    setGhost(null);
    if (!d) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.moved) {
      if (!isOverCanvas(e.clientX, e.clientY)) return;
      act(d.kind, d.key, { x: e.clientX, y: e.clientY });
    } else {
      act(d.kind, d.key, null);
    }
  };
  const cancel = () => {
    drag.current = null;
    setGhost(null);
  };
  const act = (kind: "tool" | "table", key: string, at: DropPoint) => {
    if (kind === "table") {
      // Already on the canvas: centre on it, whether clicked or dragged —
      // a second add never moves what is there. Centring is
      // navigation, so the lock leaves it.
      if (onCanvas.has(normalName(key))) centreOn(key);
      else if (!lockReason) onAddSource(key, at);
      return;
    }
    if (lockReason) return;
    const op = operations.find((o) => o.id === key);
    if (op && !(op.availability && !op.availability.available)) onAddTool(op, at);
  };
  const keyed = (e: KeyboardEvent<HTMLElement>, kind: "tool" | "table", key: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act(kind, key, null);
    }
  };

  return (
    <aside ref={paneRef} className={styles.pane} aria-label="Sources and tools" data-canvas-pane>
      {/* The application's content tabs, as the SQL workspace's pane and the
          builder's inspector wear them. */}
      <div className={styles.paneTabs}>
        <Tabs
          group="canvas-pane"
          label="Sources or tools"
          value={tab}
          onChange={setTab}
          fill
          tabs={[
            {
              value: "sources",
              name: "Sources",
              label: (
                <>
                  <DatabaseIcon />
                  Sources <span className={styles.tabCount}>{listed.length}</span>
                </>
              ),
            },
            {
              value: "tools",
              name: "Tools",
              label: (
                <>
                  <ToolsIcon />
                  Tools <span className={styles.tabCount}>{operations.length}</span>
                </>
              ),
            },
          ]}
        />
      </div>
      {lockReason && !viewOnly ? (
        <p className={styles.paneLock} role="status" data-pane-locked>
          {lockReason}
        </p>
      ) : null}
      <div className={styles.paneTop}>
        <div className={styles.paneSearch}>
          <SearchIcon />
          <input
            type="search"
            className={styles.paneSearchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "tools" ? "Search tools…" : "Search sources…"}
            aria-label={tab === "tools" ? "Search tools" : "Search sources"}
          />
        </div>
      </div>
      <TabPanel group="canvas-pane" value={tab} className={styles.paneBody}>
        {tab === "sources" ? (
          groups.length === 0 ? (
            <p className={styles.paneEmpty}>{sq ? `No source matches “${queries.sources.trim()}”.` : "No tables yet."}</p>
          ) : (
            groups.map((g) => (
              <div key={g.key} className={styles.paneGroup}>
                <p className={styles.eyebrow}>{g.label}</p>
                {g.tables.map(({ table }) => {
                  const here = onCanvas.has(normalName(table.name));
                  return (
                    <button
                      key={table.id}
                      type="button"
                      className={styles.tableRow}
                      data-on={here || undefined}
                      data-table={table.name}
                      disabled={lockReason !== null && !here}
                      aria-label={
                        here
                          ? `${table.name}, on canvas: centre the view on it`
                          : lockReason
                            ? `Add ${table.name} to the canvas: ${lockReason}`
                            : `Add ${table.name} to the canvas`
                      }
                      onPointerDown={(e) => press(e, "table", table.name, table.name)}
                      onPointerMove={move}
                      onPointerUp={release}
                      onPointerCancel={cancel}
                      onKeyDown={(e) => keyed(e, "table", table.name)}
                    >
                      <span className={styles.rowGlyph} data-kind={table.geometryColumn !== null ? "spatial" : "none"}>
                        <GeometryGlyph geometryType={geometryGlyphType(table)} />
                      </span>
                      <span className={styles.rowName}>{table.name}</span>
                      {here ? (
                        <span className={styles.onCanvas}>on canvas</span>
                      ) : (
                        <span className={styles.rowMeta}>{formatCount(table.rowCount)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )
        ) : tools.length === 0 ? (
          <p className={styles.paneEmpty}>{`No tool matches “${queries.tools.trim()}”.`}</p>
        ) : (
          tools.map(([group, ops]) => (
            <div key={group} className={styles.paneGroup} data-pane-group={group}>
              <p className={styles.eyebrow}>{group}</p>
              {ops.map((op) => {
                const unavailable = !!op.availability && !op.availability.available;
                return (
                  <button
                    key={op.id}
                    type="button"
                    className={styles.toolRow}
                    data-grp={op.group}
                    data-unavailable={unavailable || undefined}
                    data-tool={op.id}
                    disabled={unavailable || lockReason !== null}
                    aria-label={
                      unavailable ? `${op.label}: ${op.availability?.reason ?? "unavailable"}` : lockReason ? `Add ${op.label}: ${lockReason}` : `Add ${op.label}`
                    }
                    onPointerDown={(e) => press(e, "tool", op.id, op.label)}
                    onPointerMove={move}
                    onPointerUp={release}
                    onPointerCancel={cancel}
                    onKeyDown={(e) => keyed(e, "tool", op.id)}
                  >
                    <span className={styles.toolGlyph}>
                      <OperationGlyph symbol={op.symbol} />
                    </span>
                    <span className={styles.toolText}>
                      <span className={styles.toolName}>{op.label}</span>
                      <span className={styles.toolBlurb}>{op.blurb}</span>
                      {unavailable ? <span className={styles.toolWhy}>{op.availability?.reason}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </TabPanel>
      {tab === "sources" && !viewOnly ? (
        <div className={styles.paneFoot}>
          <button type="button" className={styles.dashedBtn} onClick={onAddData} disabled={lockReason !== null} aria-label={lockReason ? `Add data: ${lockReason}` : undefined}>
            <PlusIcon /> Add data
          </button>
        </div>
      ) : null}
      {ghost ? (
        <span className={styles.dragGhost} style={{ left: ghost.x, top: ghost.y }} aria-hidden="true">
          {ghost.label}
        </span>
      ) : null}
    </aside>
  );
}

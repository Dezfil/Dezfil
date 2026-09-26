"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  REORDER_INSTRUCTIONS,
  reorderAnnouncements,
  type ReorderHandle,
} from "../reorder-a11y";
import type { Layer } from "@/lib/metadata/maps";
import { layerSwatch } from "@/lib/layer-summary";
import { isAggregated } from "@/lib/viz";
import { ExceptionStrip } from "./ExceptionStrip";
import { offerLayer, usePickMode } from "./drawer/pick-mode";
import type { LayerRenderData } from "./render-data";
import {
  TargetIcon,
  EyeIcon,
  EyeOffIcon,
  GripIcon,
} from "../ui/icons";
import { IconButton } from "../ui/IconButton";
import { LayerRowMenu } from "./layer-row/LayerRowMenu";
import type { LayerDataDownloadPort } from "./use-layer-data-downloads";
import panel from "./panel.module.css";
import styles from "./LayerList.module.css";

interface Props {
  layers: Layer[];
  renders: Record<string, LayerRenderData>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggle: (id: string, visible: boolean) => void;
  onDelete: (id: string) => void;
  /** Sketch layers by id — the card's honest mixed-content line and
   * the owner's cascade wording read from the map-scoped sketch summary. */
  sketchByLayer?: Map<string, { sentence: string; table: string }>;
  onDuplicate: (id: string) => void;
  /** Open the analysis drawer with this layer pre-filled. */
  onRename: (id: string, name: string) => void;
  /** Frame the map to this layer's data extent. */
  onFit: (id: string) => void;
  /** Open the layer's source workbench, scoped to its id. */
  onEditSource: (id: string) => void;
  /** New full order, bottom-up (draw order) — matches the API's layerOrder. */
  onReorder: (bottomUpIds: string[]) => void;
  /** Style controls for the selected layer, rendered inside its card. */
  stylePanel: (layer: Layer) => ReactNode;
  /** Shared native-stream download road for row-menu export actions. */
  layerDataDownloads: LayerDataDownloadPort;
}

/** Card spine: a vertical bar of the layer's drawn
 * colors — constant channels show the color, data-driven ones stack the
 * class colors top to bottom as real segments. A CSS gradient here
 * bleeds a sliver of the last color at the far edge on fractional
 * sizes. The colors come from `layerSwatch`, the ONE identity-color
 * function this surface shares with the export menu (a field
 * find: the menu computed its own and drifted). */
function Spine({
  layer,
  render,
}: {
  layer: Layer;
  render: LayerRenderData | undefined;
}) {
  const { colors } = layerSwatch(layer.style, layer.viz, render);
  return (
    <span className={styles.swatch} aria-hidden>
      {colors.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** The whole card is a grab surface, except controls and the style panel. */
function dragAllowed(target: EventTarget | null): boolean {
  return !(
    target instanceof Element &&
    target.closest("input, textarea, select, [data-no-dnd]")
  );
}

class CardMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: "onMouseDown" as const,
      handler: ({ nativeEvent }: ReactMouseEvent) =>
        nativeEvent.button === 0 && dragAllowed(nativeEvent.target),
    },
  ];
}

class CardTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: "onTouchStart" as const,
      handler: ({ nativeEvent }: ReactTouchEvent) =>
        dragAllowed(nativeEvent.target),
    },
  ];
}

/** Commit the previewed slot while the card still overlaps the list; a
 *  release fully outside it cancels. */
const listCollision: CollisionDetection = (args) =>
  rectIntersection(args).length > 0 ? closestCenter(args) : [];

// Cards resize mid-drag (expanded ones collapse), so keep re-measuring.
const measuring = { droppable: { strategy: MeasuringStrategy.Always } };

const subscribeNoop = () => () => {};

// How long the released card glides into its slot; the in-list card stays
// dimmed and collapsed until then, so the two are never both fully visible.
const DROP_MS = 250;
const dropAnimation = {
  duration: DROP_MS,
  easing: "cubic-bezier(0.25, 1, 0.5, 1)",
};

function LayerMeta({
  layer,
  render,
  sketchSentence,
}: {
  layer: Layer;
  render: LayerRenderData | undefined;
  /** A sketch card states its mixed contents honestly. */
  sketchSentence?: string;
}) {
  // **The card is quiet**: no recipe sentence, no state text. Attention
  // is exception-only — the strip on the card's bottom edge.
  return (
    <span className={styles.meta}>
      {render && !render.ok ? (
        <span className={styles.errBadge}>error</span>
      ) : render?.ok && render.tiles?.state === "building" ? (
        <span className={styles.tileBadge}>preparing tiles…</span>
      ) : render?.ok ? (
        sketchSentence ??
        `${render.featureCount?.toLocaleString()} ${
          isAggregated(layer.viz) ? "cells" : "features"
        }${render.mode === "tiled" ? " · tiled" : ""}`
      ) : (
        "…"
      )}
    </span>
  );
}

/** The compact card that floats with the pointer during a drag. */
function FloatingCard({
  layer,
  render,
}: {
  layer: Layer;
  render: LayerRenderData | undefined;
}) {
  return (
    <div className={`${styles.card} ${styles.floating}`}>
      <div className={styles.head}>
        <span className={styles.grip}>
          <GripIcon />
        </span>
        <Spine layer={layer} render={render} />
        <span className={styles.label}>
          <span className={styles.name} title={layer.name}>
            {layer.name}
          </span>
          <LayerMeta layer={layer} render={render} />
        </span>
        <span className={styles.eye} data-off={!layer.visible}>
          {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
        </span>
      </div>
    </div>
  );
}

function SortableCard({
  id,
  selected,
  errored,
  dropping,
  head,
  expanded,
  foot,
}: {
  id: string;
  selected: boolean;
  errored: boolean;
  dropping: boolean;
  head: (handle: ReorderHandle) => ReactNode;
  expanded: ReactNode | null;
  /** The card's bottom edge — the exception strip's seat. */
  foot?: ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      className={styles.card}
      style={style}
      data-selected={selected}
      data-errored={errored || undefined}
      data-dragging={isDragging || dropping || undefined}
    >
      <div className={styles.head}>
        {head({ ref: setActivatorNodeRef, attributes })}
      </div>
      {expanded !== null && !isDragging && !dropping && (
        <div className={styles.expanded} data-no-dnd>
          {expanded}
        </div>
      )}
      {foot}
    </li>
  );
}

export function LayerList({
  layers,
  renders,
  selectedId,
  onSelect,
  onToggle,
  onDelete,
  sketchByLayer,
  onDuplicate,
  onRename,
  onFit,
  onEditSource,
  onReorder,
  stylePanel,
  layerDataDownloads,
}: Props) {
  // The armed Select mode, for the cards' pick affordance.
  const pick = usePickMode();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Confirm-before-acting (nothing happens silently) moved into the row's
  // overflow menu with the actions it guards.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [droppingId, setDroppingId] = useState<string | null>(null);
  const dropTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (dropTimer.current) clearTimeout(dropTimer.current);
    },
    [],
  );
  // Browsers can fire a stray click on the source card right after a
  // drop; without this guard it would toggle the card's selection.
  const justDraggedRef = useRef(false);
  // The drag overlay portals into document.body, which only exists
  // client-side; this resolves false during SSR/hydration, true after.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const sensors = useSensors(
    useSensor(CardMouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(CardTouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (layers.length === 0) {
    return (
      <p className={styles.empty}>
        No layers yet. Add one with the Add layer card, or promote a SQL
        result from the workspace.
      </p>
    );
  }

  // Draw order is bottom-up; show top layer first, matching the map stack.
  const ordered = [...layers].reverse();
  const activeLayer = activeId
    ? (ordered.find((l) => l.id === activeId) ?? null)
    : null;

  const endDrag = (id: string) => {
    setActiveId(null);
    // Hold the in-list card in its dimmed, collapsed form until the
    // floating card has glided into it, then reveal.
    setDroppingId(id);
    if (dropTimer.current) clearTimeout(dropTimer.current);
    dropTimer.current = setTimeout(() => setDroppingId(null), DROP_MS);
    justDraggedRef.current = true;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    endDrag(String(active.id));
    if (!over || over.id === active.id) return;
    const ids = ordered.map((l) => l.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to).reverse());
  };

  const announcements = reorderAnnouncements(
    new Map(ordered.map((l) => [l.id, l.name])),
    ordered.map((l) => l.id),
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={listCollision}
      modifiers={[restrictToVerticalAxis]}
      measuring={measuring}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: REORDER_INSTRUCTIONS },
      }}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={({ active }) => endDrag(String(active.id))}
    >
      <SortableContext
        items={ordered.map((l) => l.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul
          className={styles.list}
          data-layer-list=""
          data-sorting={activeId ? true : undefined}
          data-picking={pick.armed ? true : undefined}
        >
          {ordered.map((layer) => {
            const render = renders[layer.id];
            const errored = render && !render.ok;
            const selected = layer.id === selectedId;
            return (
              <SortableCard
                key={layer.id}
                id={layer.id}
                selected={selected}
                errored={!!errored}
                dropping={droppingId === layer.id}
                expanded={selected ? stylePanel(layer) : null}
                foot={<ExceptionStrip layer={layer} />}
                head={(handle) => (
                  <>
                    <button
                      type="button"
                      ref={handle.ref}
                      {...handle.attributes}
                      className={`${styles.grip} ${panel.hint}`}
                      data-hint="Drag or Space to reorder"
                      aria-label={`Reorder ${layer.name}`}
                    >
                      <GripIcon />
                    </button>

                    <Spine layer={layer} render={render} />

                    {renamingId === layer.id ? (
                      <input
                        className={styles.renameInput}
                        value={renameValue}
                        autoFocus
                        aria-label="Layer name"

                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => {
                          setRenamingId(null);
                          if (renameValue.trim())
                            onRename(layer.id, renameValue.trim());
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                    ) : (
                      <button
                        className={styles.label}
                        data-layer-select={layer.id}
                        onClick={() => {
                          if (justDraggedRef.current) return;
                          // **Select mode eats the click**: an armed
                          // picker takes the card before selection does,
                          // success and refusal alike.
                          if (offerLayer(layer)) return;
                          onSelect(selected ? null : layer.id);
                        }}
                        onDoubleClick={() => {
                          setRenameValue(layer.name);
                          setRenamingId(layer.id);
                        }}
                      >
                        <span className={styles.name} title={layer.name}>
                          {layer.name}
                        </span>
                        <LayerMeta
                          layer={layer}
                          render={render}
                          sketchSentence={sketchByLayer?.get(layer.id)?.sentence}
                        />
                      </button>
                    )}

                    <span className={styles.actions} data-no-dnd>
                      <IconButton
                        className={styles.iconBtn}
                        action="Zoom to layer"
                        icon={<TargetIcon />}
                        disabled={
                          !render?.ok ||
                          (!render.geojson && !render.tiles?.bounds)
                        }
                        onClick={() => onFit(layer.id)}
                      />
                      <IconButton
                        className={styles.eye}
                        tone={layer.visible ? "accent" : "default"}
                        action={layer.visible ? "Hide layer" : "Show layer"}
                        icon={layer.visible ? <EyeIcon /> : <EyeOffIcon />}
                        onClick={() => onToggle(layer.id, !layer.visible)}
                      />
                      <LayerRowMenu
                        layerId={layer.id}
                        layerName={layer.name}
                        onEditSource={() => onEditSource(layer.id)}
                        onRename={() => {
                          setRenameValue(layer.name);
                          setRenamingId(layer.id);
                        }}
                        onDuplicate={() => onDuplicate(layer.id)}
                        onDelete={() => onDelete(layer.id)}
                        cascade={sketchByLayer?.has(layer.id) ?? false}
                        cascadeDataset={sketchByLayer?.get(layer.id)?.table}
                        layerDataDownloads={layerDataDownloads}
                      />
                    </span>
                  </>
                )}
              />
            );
          })}
        </ul>
      </SortableContext>
      {mounted &&
        createPortal(
          <DragOverlay
            style={{ height: "auto" }}
            zIndex={1000}
            dropAnimation={dropAnimation}
          >
            {activeLayer ? (
              <FloatingCard
                layer={activeLayer}
                render={renders[activeLayer.id]}
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
}

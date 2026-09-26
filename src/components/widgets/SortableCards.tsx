"use client";

import {
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
import styles from "./SortableCards.module.css";

/**
 * The layer list's drag feel, extracted for dashboard cards: rail cards
 * and tab rows reorder by grabbing anywhere that is not an interactive
 * control. Items shift with the sort animation and the released card
 * reveals from the drag dim while the floating copy glides into its
 * slot. The reveal is a CSS animation whose resting frame is full
 * opacity — a timer-cleared state here once left cards dimmed forever
 * when the clearing render was lost (round-1 field fix).
 */

/** Interactive internals opt out of being grab surfaces. */
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

// How long the released card glides into its slot (matches the reveal).
const DROP_MS = 250;
const dropAnimation = {
  duration: DROP_MS,
  easing: "cubic-bezier(0.25, 1, 0.5, 1)",
};

function SortableItem({
  id,
  dropped,
  children,
}: {
  id: string;
  /** The item a drag just released; plays the reveal animation. */
  dropped: boolean;
  children: (handle: ReorderHandle) => ReactNode;
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
    ...(isDragging ? { opacity: 0.35 } : null),
  };
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={style}
      className={dropped && !isDragging ? styles.dropped : undefined}
    >
      {children({ ref: setActivatorNodeRef, attributes })}
    </div>
  );
}

export function SortableCards({
  ids,
  onReorder,
  render,
  overlayWidth,
  keyboardNames,
}: {
  /** Item ids, in display order. */
  ids: string[];
  /** The full new order after a drop. */
  onReorder: (ids: string[]) => void;
  /** Render one item's card (also used for the floating copy). While the
   * item is actively dragged, dragging is true for the in-list copy —
   * expanded content should collapse for the duration. The handle is
   * the keyboard activator: spread it on a grip to make the item
   * keyboard-sortable — hosts that don't render one stay pointer-only.
   * */
  render: (
    id: string,
    floating: boolean,
    dragging?: boolean,
    handle?: ReorderHandle,
  ) => ReactNode;
  /** Width of the floating copy (the rail's card width, the tab's row). */
  overlayWidth?: number | string;
  /** Display names by id. Present ⇒ this host sorts by keyboard too
   * the keyboard sensor arms and moves announce. The widget rail passes
   * nothing — its keyboard path is the Widgets tab, which edits the
   * same order. */
  keyboardNames?: Map<string, string>;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // The item whose drop reveal should play. Never cleared by a timer —
  // the animation's end state is the resting one — only superseded by
  // the next drag.
  const [droppedId, setDroppedId] = useState<string | null>(null);
  // The drag overlay portals into document.body — client-side only.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const mouse = useSensor(CardMouseSensor, {
    activationConstraint: { distance: 5 },
  });
  const touch = useSensor(CardTouchSensor, {
    activationConstraint: { delay: 200, tolerance: 6 },
  });
  // Armed only for keyboard hosts: without an activator grip the sensor
  // would start a sort from any key landing on the card body.
  const kbd = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  const sensors = useSensors(mouse, touch, keyboardNames ? kbd : undefined);

  const endDrag = (id: string) => {
    setActiveId(null);
    setDroppedId(id);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    endDrag(String(active.id));
    if (!over || over.id === active.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={listCollision}
      modifiers={[restrictToVerticalAxis]}
      measuring={measuring}
      accessibility={
        keyboardNames
          ? {
              announcements: reorderAnnouncements(keyboardNames, ids),
              screenReaderInstructions: { draggable: REORDER_INSTRUCTIONS },
            }
          : undefined
      }
      onDragStart={({ active }) => {
        setActiveId(String(active.id));
        setDroppedId(null);
      }}
      onDragEnd={handleDragEnd}
      onDragCancel={({ active }) => endDrag(String(active.id))}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {ids.map((id) => (
          <SortableItem key={id} id={id} dropped={droppedId === id}>
            {(handle) => render(id, false, id === activeId, handle)}
          </SortableItem>
        ))}
      </SortableContext>
      {mounted &&
        createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {activeId ? (
              <div style={{ width: overlayWidth, cursor: "grabbing" }}>
                {render(activeId, true)}
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
}

import type { Announcements, DraggableAttributes } from "@dnd-kit/core";

/** The keyboard side of sortable lists. Dnd-kit only starts
 * a keyboard sort from the sortable's activator node, so a grip wired as
 * the activator scopes pick-up away from every editing key inside a
 * card; these helpers are the shared naming and announcement halves. */

export interface ReorderHandle {
  ref: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes;
}

export const REORDER_INSTRUCTIONS =
  "To reorder, press Space or Enter, move with the arrow keys, then press Space or Enter again to drop. Press Escape to cancel.";

/** Announcements speak in display positions, so they are built from the
 * display order the host renders. */
export function reorderAnnouncements(
  names: Map<string, string>,
  ids: string[],
): Announcements {
  const n = ids.length;
  const name = (id: unknown) => names.get(String(id)) ?? "The item";
  const at = (id: unknown) => ids.indexOf(String(id)) + 1;
  return {
    onDragStart: ({ active }) =>
      `${name(active.id)} picked up, position ${at(active.id)} of ${n}.`,
    onDragOver: ({ active, over }) =>
      over
        ? over.id === active.id
          ? // Hovering its own slot says nothing new — and would talk over
            // the pick-up announcement, which fires with this one.
            undefined
          : `${name(active.id)} over position ${at(over.id)} of ${n}.`
        : `${name(active.id)} is outside the list.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${name(active.id)} dropped at position ${at(over.id)} of ${n}.`
        : `${name(active.id)} returned to its place.`,
    onDragCancel: ({ active }) =>
      `Reorder cancelled. ${name(active.id)} returned to position ${at(
        active.id,
      )} of ${n}.`,
  };
}

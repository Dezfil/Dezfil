"use client";

import type { NoteColor } from "@/lib/metadata/recipe-layouts";
import { IconButton } from "../ui/IconButton";
import { DuplicateIcon, PencilIcon, TrashIcon } from "../ui/icons";
import type { NoteActions } from "./note-actions";
import { NOTE_COLOR_NAMES } from "./note-geometry";
import type { LayoutNote } from "./placement";
import styles from "./NoteNode.module.css";

const HEIGHT = 36;
const MARGIN = 8;

/**
 * The note menu: above the selected note, the six swatches named by
 * colour with the chosen one marked, Edit, Duplicate, Delete. It is the
 * canvas's own overlay, over the graph and clamped within the drawable
 * area, never part of the note's layer.
 */
export function NoteMenu({
  note,
  anchor,
  bounds,
  actions,
}: {
  note: LayoutNote;
  /** The note's box in the flow area's coordinates. */
  anchor: { x: number; y: number; w: number; h: number };
  /** The drawable area (the flow area less the pane, a panel and the
   * band), in the flow area's coordinates. */
  bounds: { left: number; top: number; right: number; bottom: number };
  actions: NoteActions;
}) {
  // Above the note; inside its top edge when the top is off the area;
  // never under the pane, a panel or the band.
  const width = Math.min(300, Math.max(160, bounds.right - bounds.left - 2 * MARGIN));
  const left = Math.max(bounds.left + MARGIN, Math.min(anchor.x, bounds.right - width - MARGIN));
  const above = anchor.y - HEIGHT - 10;
  const top = above >= bounds.top + MARGIN ? above : Math.max(bounds.top + MARGIN, Math.min(anchor.y + 10, bounds.bottom - HEIGHT - MARGIN));
  return (
    <div className={styles.menu} role="group" aria-label="Note" data-note-menu style={{ left, top, maxWidth: width }}>
      <div className={styles.swatches} role="group" aria-label="Note colour">
        {NOTE_COLOR_NAMES.map((c) => (
          <button
            key={c}
            type="button"
            className={styles.swatch}
            data-color={c}
            data-note-swatch={c}
            aria-label={c}
            aria-pressed={note.color === c}
            onClick={() => actions.recolour(note.id, c as NoteColor)}
          />
        ))}
      </div>
      <span className={styles.sep} aria-hidden="true" />
      <IconButton action="Edit note" icon={<PencilIcon />} onClick={() => actions.edit(note.id)} data-note-edit />
      <IconButton action="Duplicate note" icon={<DuplicateIcon />} disabled={!actions.canAdd()} onClick={() => actions.duplicate(note.id)} data-note-duplicate />
      <IconButton action="Delete note" tone="danger" icon={<TrashIcon />} onClick={() => actions.remove(note.id)} data-note-delete />
    </div>
  );
}

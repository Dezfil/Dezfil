import { controlOwnsKey } from "./key-ownership";

/**
 * The page's text selection and the canvas ("text selected across the
 * whole page"). The workflow page is chrome around a canvas, not a
 * document: its stack, rail, header, pane, panel labels, band bar and
 * notices are `user-select: none` in their stylesheets, and what a user
 * copies (a field, the note's editor, the grid's cells, the log's text,
 * the SQL that ran) stays selectable. Two gestures the stylesheets
 * cannot hold are here:
 *
 * - Cmd/Ctrl+A. With the canvas owning the key (the
 *   rule, shared with the record and the clipboard: not inside an
 *   editable control, not inside an open dialog) the browser's
 *   select-all would select the page's chrome, header to band, and no
 *   press on the canvas would clear it. The canvas takes the key and
 *   does nothing with it: multi-select stays deferred.
 *   Inside a field the key is the field's own select-all, untouched.
 * - A press on the canvas. The library's pane takes the pointer for
 *   panning and selection, so the browser's own click-to-deselect never
 *   runs there; a selection swept elsewhere on the page stayed until a
 *   reload. A press on the canvas, outside an editable control (the
 *   note's field keeps its own selection), clears it.
 *
 * Pure but for the document each asks about; no React.
 */

type Chord = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The browser's select-all chord: ⌘A on macOS, Ctrl+A elsewhere, with
 * no other modifier (⇧⌘A and ⌥⌘A are other commands). */
export function isSelectAll(e: Chord): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "a" || e.key === "A");
}

/** Whether the canvas takes this key press as a select-all: the chord,
 * and no control of its own owns it. The owner rule is injectable for
 * the unit test; the page uses the shared one. */
export function canvasTakesSelectAll(e: Chord & { target: EventTarget | null }, owns: (target: EventTarget | null) => boolean = controlOwnsKey): boolean {
  return isSelectAll(e) && !owns(e.target);
}

/** A press on the canvas clears a selection made elsewhere on the page.
 * Inside an editable control the press is that control's caret
 * placement and its selection is its own, so nothing is touched. Returns
 * whether a selection was cleared. */
export function clearStraySelection(
  target: EventTarget | null,
  owns: (target: EventTarget | null) => boolean = controlOwnsKey,
  selection: () => Selection | null = () => window.getSelection?.() ?? null,
): boolean {
  if (owns(target)) return false;
  const sel = selection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  sel.removeAllRanges();
  return true;
}

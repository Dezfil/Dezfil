import { isolateHistory } from "@codemirror/commands";
import type { EditorState, TransactionSpec } from "@codemirror/state";

/** The imperative surface a host can borrow from the SQL editor
 * (revised; the cursor verb): two host contracts — the catalog's table
 * click writes a whole statement, the SQL workspace's chips insert at
 * the caret. */
export interface SqlEditorHandle {
  /** Replace the entire document with the given text; the caret lands
   * at the end and the editor takes focus. */
  replaceAll: (text: string) => void;
  /** Insert at the current cursor, replacing any selection; the caret
   * lands after the insertion and the editor takes focus. */
  insertAtCursor: (text: string) => void;
  /** The selected text, or the empty string: the host's Run button
   * runs a selection alone the way Mod-Enter does. */
  getSelection: () => string;
  /** The selection's document offsets, or null when collapsed: a
   * position the server reports against a selected fragment is translated
   * back into the document through `from`. */
  getSelectionRange: () => { from: number; to: number } | null;
  /** Replace the entire document and select a range of the new text, as
   * one undoable step; the editor takes focus (an appended proposal is
   * selected so the person sees where it landed). */
  replaceAllSelecting: (text: string, from: number, to: number) => void;
}

/** Build the dispatch for replacing the whole document and selecting a
 * range of the new text: its own undo step, as `replaceAllSpec` is, and
 * the selection lands on the range rather than at the end. */
export function replaceAllSelectingSpec(
  state: EditorState,
  text: string,
  from: number,
  to: number,
): TransactionSpec {
  return {
    changes: { from: 0, to: state.doc.length, insert: text },
    selection: { anchor: Math.min(from, text.length), head: Math.min(to, text.length) },
    scrollIntoView: true,
    annotations: isolateHistory.of("full"),
  };
}

/** Build the dispatch for inserting text at the current cursor: the
 * selection is replaced (a collapsed cursor inserts in place — never
 * an append), and the caret lands directly after the inserted text.
 * Pure, so the contract is testable apart from the view. */
export function insertAtCursorSpec(
  state: EditorState,
  text: string,
): TransactionSpec {
  const { from, to } = state.selection.main;
  return {
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  };
}

/** Build the dispatch for replacing the whole document (the
 * table-click contract, unchanged). The replacement is its own undo step: a host's Open as SQL that lands within the
 * history's grouping delay of the user's last keystroke must not fold
 * into it, or one undo would take the keystrokes with the replacement. */
export function replaceAllSpec(
  state: EditorState,
  text: string,
): TransactionSpec {
  return {
    changes: { from: 0, to: state.doc.length, insert: text },
    selection: { anchor: text.length },
    scrollIntoView: true,
    annotations: isolateHistory.of("full"),
  };
}

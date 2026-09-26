"use client";

import { createContext, useContext } from "react";
import type { NoteColor } from "@/lib/metadata/recipe-layouts";
import type { Rect } from "./note-geometry";

/**
 * What a note asks of the canvas: the canvas owns the notes and their
 * writes; the note node only says what happened.
 */
export interface NoteActions {
  /** Open the note for editing. */
  edit: (id: string) => void;
  /** The edit closed with this text; a changed text writes. A close by
   * key returns focus to the note; a blur leaves focus where it went. */
  commit: (id: string, text: string, closedBy: "key" | "blur") => void;
  recolour: (id: string, color: NoteColor) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  /** A completed resize, as the handles left it (settled by the canvas). */
  resized: (id: string, rect: Rect) => void;
  /** Whether one more note may be made (the hundred-note limit). */
  canAdd: () => boolean;
}

export const NoteActionsContext = createContext<NoteActions | null>(null);

export function useNoteActions(): NoteActions {
  const actions = useContext(NoteActionsContext);
  if (!actions) throw new Error("NoteActionsContext is not provided");
  return actions;
}

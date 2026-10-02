"use client";
import { createContext, useContext } from "react";
import type { DocumentSequence } from "./document-sequence";
import type { Layer } from "@/lib/metadata/maps";

export interface DocumentEditorPort {
  sequence: DocumentSequence;
  request: typeof fetch;
  turn: (work: () => Promise<void>) => Promise<void>;
  /** A layer's accepted state, unavailable while it has outstanding edits. */
  settledLayer?: (layerId: string) => Layer | null;
}
export const DocumentEditorContext = createContext<DocumentEditorPort | null>(null);
/** Descendant write surfaces participate in their editor's document sequence. */
export function useEditorRequest(): typeof fetch {
  return useContext(DocumentEditorContext)?.request ?? fetch;
}

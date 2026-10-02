"use client";
import { createContext, useContext } from "react";
import type { DocumentSequence } from "./document-sequence";

export interface DocumentEditorPort {
  sequence: DocumentSequence;
  request: typeof fetch;
}
export const DocumentEditorContext = createContext<DocumentEditorPort | null>(null);
/** Descendant write surfaces participate in their editor's document sequence. */
export function useEditorRequest(): typeof fetch {
  return useContext(DocumentEditorContext)?.request ?? fetch;
}

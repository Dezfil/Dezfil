import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { acceptedDocumentFacts } from "../accepted-document-facts";
import { fetchWorkflow, type PageRead } from "./workflow-read";
import type { WorkflowDocument } from "./workflow-document";

export function useRecipeRefresh(id: string, editorDocument: WorkflowDocument, setLive: Dispatch<SetStateAction<PageRead | null>>) {
  // Every accepted change re-reads the recipe; only the newest read lands,
  // so two edits' refreshes cannot put an older snapshot on screen last.
  const refreshSeq = useRef(0);
  const latestRecipeRead = useRef<Promise<boolean> | null>(null);
  return useCallback(async (): Promise<boolean> => {
    const mine = ++refreshSeq.current;
    const accepted = acceptedDocumentFacts(editorDocument.recipe);
    setLive((l) => l ? { ...l, recipe: { ...l.recipe, ...accepted } } : l);
    const read = (async () => {
      try {
        const recipe = await fetchWorkflow(id);
        if (mine !== refreshSeq.current) return false;
        // Run results remain readable after a promotion. Presentation follows
        // the read; pending edits and local inverses keep their accepted basis.
        editorDocument.refresh(recipe);
        setLive((l) => (l ? { ...l, recipe } : l));
        return true;
      } catch {
        // The next accepted change re-reads again; the canvas keeps what it has.
        return false;
      }
    })();
    latestRecipeRead.current = read;
    const landed = await read;
    // Superseded by a newer read: its landing is the answer.
    if (!landed && mine !== refreshSeq.current && latestRecipeRead.current) return latestRecipeRead.current;
    return landed;
  }, [id, editorDocument, setLive]);
}

import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { DocumentEditorPort } from "../document-editor-context";
import type { WorkflowDocument } from "./workflow-document";
import type { WorkflowRunner } from "./use-workflow-run";
import { fetchWorkflow, fetchLayout, type PageRead } from "./workflow-read";

/** Embedded turns share the editor's sequence and install a paired read
 * before later intent proceeds. Run observation follows that accepted state. */
export function useWorkflowEditorPort(
  id: string,
  document: WorkflowDocument,
  runner: WorkflowRunner,
  refreshTables: () => Promise<boolean>,
  setLive: Dispatch<SetStateAction<PageRead | null>>,
): DocumentEditorPort {
  return useMemo(() => ({
    sequence: document,
    request: document.request,
    turn: (work: () => Promise<void>) => document.enqueue(async () => {
      if (document.stale) throw new Error(document.haltMessage);
      await work();
      if (document.stale) return;
      const [recipe, layout] = await Promise.all([fetchWorkflow(id), fetchLayout(id)]);
      document.install(recipe, layout);
      void runner.observe();
      void refreshTables();
      setLive(current => current ? { ...current, recipe, layout } : current);
    }),
  }), [document, id, runner, refreshTables, setLive]);
}

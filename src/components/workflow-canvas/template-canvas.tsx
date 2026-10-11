"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PageRead } from "./workflow-read";

/**
 * The canvas of a template's workflow example, on the template's own page.
 *
 * A template's workflow is no one's recipe: no recipe, run or dataset road
 * answers it, and its datasets are listed in no one's data. So its page
 * hands the canvas the template's documents through the read seam, and
 * the canvas reads nothing else of its own: no runs (there are none), no
 * dataset facts, columns, rows or dry runs, no results band. The pane's
 * place holds the template's How it's made instead of Sources and Tools,
 * and a node's output row names the template's result, never a run. The
 * canvas is view-only besides, as for a Viewer.
 */
export interface TemplateCanvasSeam {
  /** The template's documents, as a workflow's page reads its own. */
  read: () => Promise<PageRead>;
  /** What stands where the pane would. */
  pane: ReactNode;
}

const TemplateCanvasContext = createContext<TemplateCanvasSeam | null>(null);

export function TemplateCanvas({ value, children }: { value: TemplateCanvasSeam | null; children: ReactNode }) {
  return <TemplateCanvasContext.Provider value={value}>{children}</TemplateCanvasContext.Provider>;
}

/** The template's seam when this canvas is a template's, else null. */
export function useTemplateCanvas(): TemplateCanvasSeam | null {
  return useContext(TemplateCanvasContext);
}

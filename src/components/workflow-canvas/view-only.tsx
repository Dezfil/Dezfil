"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The view-only canvas: the workflow page of whoever may not change it, a
 * Viewer, or anyone while its owner is deactivated. The page decides it
 * once, from the reader's standing as the server holds it, and nothing on
 * the page can change it: the lock stays engaged with no unlock, and the
 * controls that edit are not drawn. The run controls stay only for whoever
 * may still run it (a frozen workflow's Editors), never for a Viewer. The
 * reason every refused control gives is the API's own permission refusal,
 * word for word.
 */

export const VIEW_ONLY_REASON = "You can view this but cannot make this change.";

const ViewOnlyContext = createContext({ viewOnly: false, runs: true });

export function ViewOnly({
  value,
  runs = !value,
  children,
}: {
  value: boolean;
  /** Whether the run controls are offered; by default only on a canvas
   * that edits. */
  runs?: boolean;
  children: ReactNode;
}) {
  return <ViewOnlyContext.Provider value={{ viewOnly: value, runs }}>{children}</ViewOnlyContext.Provider>;
}

/** Whether this page shows the canvas view-only. */
export function useViewOnly(): boolean {
  return useContext(ViewOnlyContext).viewOnly;
}

/** Whether this page offers the workflow's runs. */
export function useRunsOffered(): boolean {
  return useContext(ViewOnlyContext).runs;
}

"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The view-only canvas: a Viewer's workflow page. The page decides it once,
 * from the reader's standing as the server holds it, and nothing on the
 * page can change it: the lock stays engaged with no unlock, and the
 * controls that edit or run are not drawn. The reason every refused control
 * gives is the API's own permission refusal, word for word.
 */

export const VIEW_ONLY_REASON = "You can view this but cannot make this change.";

const ViewOnlyContext = createContext(false);

export function ViewOnly({ value, children }: { value: boolean; children: ReactNode }) {
  return <ViewOnlyContext.Provider value={value}>{children}</ViewOnlyContext.Provider>;
}

/** Whether this page shows the canvas view-only. */
export function useViewOnly(): boolean {
  return useContext(ViewOnlyContext);
}

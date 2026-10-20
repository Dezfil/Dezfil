"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * How a map's first view is framed. The map page decides on the server as
 * it is served: a map opens at its saved view, and only one with no view of
 * its own yet opens framed to its data. The builder and the reader take the
 * answer from here, so neither reads an instance default. Outside a page
 * that hands one down (a test, a template's preview) a map opens at its
 * saved view.
 */
const MapOpeningContext = createContext(false);

export function MapOpeningProvider({ framed, children }: { framed: boolean; children: ReactNode }) {
  return <MapOpeningContext.Provider value={framed}>{children}</MapOpeningContext.Provider>;
}

/** Whether the map opens framed to its data. */
export function useOpensFramed(): boolean {
  return useContext(MapOpeningContext);
}

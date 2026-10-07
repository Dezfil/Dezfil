"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useRailShift } from "../rail-mode";
import { bandLimits, bandOf, type Band } from "./helper-bands";

/**
 * The viewport's width band, where the rail beside the page puts its
 * limits. Every page that docks or overlays a helper (the builder's two,
 * the workflow canvas's and the SQL console's assistant) measures the
 * viewport with the rail's width inside its chrome, so a rail the person
 * keeps standing open (Always open) moves both limits up by its shift,
 * read from the root as the rail reads its pick. One subscription, so the
 * pages cannot disagree about where a band starts.
 */

/** The width queries at the bands' two limits. */
function bandSubscription(railShift: number) {
  const { overlayAtMost, bothFrom } = bandLimits(railShift);
  return (onChange: () => void): (() => void) => {
    const narrow = window.matchMedia(`(max-width: ${overlayAtMost}px)`);
    const wide = window.matchMedia(`(min-width: ${bothFrom}px)`);
    narrow.addEventListener("change", onChange);
    wide.addEventListener("change", onChange);
    return () => {
      narrow.removeEventListener("change", onChange);
      wide.removeEventListener("change", onChange);
    };
  };
}

/** The server renders the one-docked layout; the client corrects on first paint. */
const serverBand = (): Band => "one";

export function useViewportBand(): Band {
  const railShift = useRailShift();
  const subscribe = useMemo(() => bandSubscription(railShift), [railShift]);
  const read = useCallback((): Band => bandOf(window.innerWidth, railShift), [railShift]);
  return useSyncExternalStore(subscribe, read, serverBand);
}

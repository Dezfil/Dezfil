"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewTheme } from "./view-theme";

/**
 * The reader theme controller. It owns a load-local switch over the
 * authored default and applies it to the published-scope wrapper as an
 * attribute flip — never a remount, so viewport, filters, selections and
 * timeline state stay put. The wrapper lives above the viewer (the route
 * stamps it), so the controller reaches it from the viewer root.
 *
 * Since the switch is not remembered: state starts empty on every load,
 * so a refresh returns to whatever the author currently publishes. That
 * is also what lets an authored change reach a reader who has already
 * used the toggle.
 */
export function useViewTheme(): {
  /** The effective theme once the authored default is known. */
  effective: (authored: ViewTheme) => ViewTheme;
  toggle: (authored: ViewTheme) => void;
  /** Attach to the viewer root so the controller can find the wrapper. */
  rootRef: React.RefObject<HTMLDivElement | null>;
} {
  const [chosen, setChosen] = useState<ViewTheme | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const effective = useCallback(
    (authored: ViewTheme): ViewTheme => chosen ?? authored,
    [chosen],
  );

  const toggle = useCallback((authored: ViewTheme) => {
    setChosen((current) => ((current ?? authored) === "dark" ? "light" : "dark"));
  }, []);

  return { effective, toggle, rootRef };
}

/**
 * Keeps the published-scope wrapper's attribute equal to the effective
 * theme. It covers both directions: the reader's own switch, and a
 * payload refresh that carries an authored update made in the builder —
 * without this the chrome would hold the original server stamp while the
 * canvas followed the new payload.
 */
export function useSyncViewTheme(
  rootRef: React.RefObject<HTMLDivElement | null>,
  effective: ViewTheme | null,
): void {
  useEffect(() => {
    if (!effective) return;
    rootRef.current
      ?.closest("[data-published-view]")
      ?.setAttribute("data-view-theme", effective);
  }, [rootRef, effective]);
}

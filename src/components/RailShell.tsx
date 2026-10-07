"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { hotZoneShare } from "./rail-hot-zone";
import { RailModeContext, useRailMode } from "./rail-mode";

// Pointer intent for the workspace rail (the hot zone). The rail expands
// only after a sustained hover over the collapsed rail's hot zone — on
// the map builder its left two-thirds, so a pointer crossing it on the
// way to the inspector card, or resting on the right third, never opens
// it; on every other page the whole rail. A crossing never opens it
// anywhere: the dwell holds on every page. Keyboard expansion stays in
// CSS (`:focus-visible`) and takes no dwell; touch pointers are ignored
// entirely. The dwell is interaction semantics, so it lives here rather
// than in a transition delay — reduced motion strips the animation,
// never the dwell.
//
// All of that is the person's default Side menu pick, Opens on hover.
// Always open stands the rail open by the stylesheet and Icons only never
// opens it, so under either the dwell never arms and the keyboard rule is
// gated off; the items learn the pick so they can name themselves in a
// hint beside the icon when the rail stays shut.

/** Dwell before a resting pointer expands the rail. Shipped 400ms;
 * a field round ruled it back to 150ms, and
 * brought it to 100ms with the whole rail hot off the builder. It stays
 * on every page — the dwell is wanted, not an instant open — and it is
 * what keeps a crossing from triggering: a pointer
 * traverses the rail far faster than this. */
const EXPAND_DWELL_MS = 100;

export function RailShell({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  const mode = useRailMode();
  const [expanded, setExpanded] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  // The layout persists across route changes, so the page under the rail
  // is a live reading of the route, never a value fixed at mount.
  const hotZone = hotZoneShare(usePathname());
  // The zone at fire time and the pointer's last position: a navigation
  // the rail did not start (a map card's push) can commit while a dwell
  // is armed, and the zone it was armed under is not the zone it fires
  // under.
  const hotZoneRef = useRef(hotZone);
  // A layout effect: it runs in the commit's own task, so the timer
  // cannot fire between the route landing and the zone following it.
  useLayoutEffect(() => {
    hotZoneRef.current = hotZone;
  }, [hotZone]);
  const lastXRef = useRef(0);

  const cancelDwell = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => cancelDwell, [cancelDwell]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch" || expanded || mode !== "hover") return;
      const nav = navRef.current;
      if (!nav) return;
      const rect = nav.getBoundingClientRect();
      lastXRef.current = event.clientX;
      const inHotZone = event.clientX - rect.left <= rect.width * hotZone;
      if (!inHotZone) {
        cancelDwell();
        return;
      }
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          // Revalidate against the zone of the page the rail is on NOW:
          // a pointer that armed the dwell where the whole rail is hot may
          // be resting in the builder's corridor by the time it fires.
          const current = navRef.current;
          if (!current) return;
          const box = current.getBoundingClientRect();
          if (lastXRef.current - box.left <= box.width * hotZoneRef.current) {
            setExpanded(true);
          }
        }, EXPAND_DWELL_MS);
      }
    },
    [expanded, hotZone, cancelDwell, mode],
  );

  const onPointerLeave = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      cancelDwell();
      setExpanded(false);
    },
    [cancelDwell],
  );

  return (
    <nav
      ref={navRef}
      className={className}
      aria-label="Product navigation"
      // Only Opens on hover expands: a pick that leaves it lets an open
      // rail go at once.
      data-expanded={(expanded && mode === "hover") || undefined}
      // A hint inside the rail stands beside its icon, never over the next.
      data-hint-place="beside"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      // A click that navigates must not leave the dwell armed: the layout
      // persists across route changes, so a surviving timer would expand
      // the rail on the destination page.
      onClick={cancelDwell}
    >
      <RailModeContext.Provider value={mode}>{children}</RailModeContext.Provider>
    </nav>
  );
}

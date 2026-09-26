"use client";

import { useEffect, useState } from "react";

/**
 * Keep a flag raised for a moment after its producer lowers it.
 *
 * A chip's exit is a CSS fade, and a fade cannot fade text that is gone:
 * a message removed from the DOM the instant its counter settles takes
 * its own exit with it. A caller renders its message while this reads
 * true and marks the line off from the live value, so the box closes on
 * something legible — which is what the header span did for free by
 * keeping its literal permanently mounted.
 *
 * `ms` of zero or less is the identity: the flag passes through
 * untouched, with no timer, so a producer that never had an exit hold
 * does not acquire one.
 *
 * Plain `setTimeout`, not `window.setTimeout`: this runs under the unit
 * suite's hook scheduler as well as in a browser.
 */
export function useLingering(on: boolean, ms: number): boolean {
  // Raised during render, guarded so it converges; lowered only from the
  // timer, never synchronously inside an effect.
  const [held, setHeld] = useState(false);
  if (on && !held) setHeld(true);
  useEffect(() => {
    if (ms <= 0 || on) return;
    const timer = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return ms <= 0 ? on : on || held;
}

"use client";

import { useEffect } from "react";
import { contributeHeaderMin, releaseHeaderMin } from "./header-min";

/**
 * A surface with a left pane lends the header card its reach (for the
 * builder; gives the workflow canvas and the SQL console the same
 * voice): the pane's right edge is announced as the card's minimum
 * width, re-measured as the pane resizes and as the window does, and
 * released when the surface leaves so a list page's card shrinks to its
 * content again. Measured, never a copied number: the pane's own
 * geometry is the truth.
 *
 * The pane is found by a getter rather than a ref because the builder's
 * pane and its chrome are siblings, not parent and child.
 */
export function useHeaderReach(pane: () => HTMLElement | null): void {
  useEffect(() => {
    const el = pane();
    if (!el) return;
    const announce = () => contributeHeaderMin(el.getBoundingClientRect().right);
    announce();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(announce);
    observer?.observe(el);
    window.addEventListener("resize", announce);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", announce);
      releaseHeaderMin();
    };
    // The getter reads the DOM once on mount; the pane it finds does not
    // change identity while the surface is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

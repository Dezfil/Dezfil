"use client";

import { useSyncExternalStore } from "react";

/**
 * The header card's minimum reach: the builder
 * announces its layer pane's right edge, so the card above stacks
 * aligned with the pane when the path is short. Nothing else
 * contributes; a surface that leaves clears it, so a list page's card
 * shrinks to its content again. Measured, never a copied number: the
 * pane's own geometry is the truth.
 */

const EVENT = "dezfil:header-min";

let paneRight: number | null = null;

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

/** The builder's pane announces where its right edge is (viewport px). */
export function contributeHeaderMin(right: number | null): void {
  paneRight = right;
  window.dispatchEvent(new Event(EVENT));
}

export function releaseHeaderMin(): void {
  contributeHeaderMin(null);
}

export function useHeaderMin(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => paneRight,
    () => null,
  );
}

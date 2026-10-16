"use client";

import { useEffect, useRef, useState } from "react";
import type { PinnedPopup } from "./canvas-pointer";
import type { RenderedLayer } from "./MapCanvas";
import { pickOwner } from "./pick-owner";

/** How many canvases have a pop-up pinned right now. */
let pinnedCount = 0;

/** Whether a pop-up is pinned on any canvas, readable outside React: the
 * builder's draw mode lets a plain Escape through to close it before the
 * press leaves draw mode. */
export function pinnedPopupOpen(): boolean {
  return pinnedCount > 0;
}

/**
 * The canvas's click-pinned pop-up, out of the map monolith (the at-touch
 * decomposition slice): the card's state, the ref the deck handlers read,
 * Escape to close it, viewer and builder alike, and its end when the
 * feature it describes is gone.
 */
export function usePinnedPopup(layers: readonly RenderedLayer[]) {
  const [pinned, setPinned] = useState<PinnedPopup | null>(null);
  const pinnedRef = useRef<PinnedPopup | null>(null);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);

  // A card describes one feature: once its layer has left the map, or a
  // feature with a stable identity has left its layer's data (a drawn
  // shape deleted), the card goes with it. Checked as the layers arrive,
  // the documented adjust-on-prop-change pattern.
  const [checked, setChecked] = useState(layers);
  if (checked !== layers) {
    setChecked(layers);
    if (pinned && describesNothing(pinned, layers)) setPinned(null);
  }

  const open = pinned !== null;
  useEffect(() => {
    if (!open) return;
    pinnedCount += 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      pinnedCount -= 1;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { pinned, setPinned, pinnedRef };
}

/** True when the card's feature is known gone. A feature without an
 * identity of its own cannot be told apart from new data, and a layer
 * between answers (or drawn from tiles) holds nothing to read, so neither
 * ends a card. */
function describesNothing(pinned: PinnedPopup, layers: readonly RenderedLayer[]): boolean {
  const owner = pickOwner(layers, pinned.layerId);
  if (!owner) return true;
  if (pinned.featureId === undefined || owner.tiles) return false;
  const features = (owner.geojson as { features?: unknown } | null | undefined)?.features;
  if (!Array.isArray(features)) return false;
  return !features.some(
    (feature: { properties?: Record<string, unknown> | null } | null) =>
      feature?.properties?.feature_id === pinned.featureId,
  );
}

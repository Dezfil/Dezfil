"use client";

import { useEffect, useRef, type RefObject } from "react";
import maplibregl from "maplibre-gl";
import styles from "./search-marker.module.css";

/**
 * The transient search marker: a maplibre DOM marker with the result's
 * name and an accessible × control, dismissed by Escape or ×, moved by
 * the next located selection, and torn down symmetrically with its map
 * — nothing persists. Builder-only: the published viewer never passes
 * one.
 */

export interface SearchMarkerRequest {
  lng: number;
  lat: number;
  label: string;
}

const PIN =
  '<svg viewBox="0 0 20 26" width="20" height="26" fill="none" aria-hidden="true">' +
  '<path d="M10 25s8-8.4 8-14A8 8 0 0 0 2 11c0 5.6 8 14 8 14z" fill="currentColor"/>' +
  '<circle cx="10" cy="10.4" r="3.2" fill="var(--bg-panel)"/></svg>';

export function useSearchMarker(
  mapRef: RefObject<maplibregl.Map | null>,
  marker: SearchMarkerRequest | null | undefined,
  onDismiss?: () => void,
): void {
  // The dismiss callback rides a ref so a re-rendered handler does not
  // rebuild the marker mid-animation.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !marker) return;

    const el = document.createElement("div");
    el.className = styles.marker;
    const chip = document.createElement("div");
    chip.className = styles.chip;
    const label = document.createElement("span");
    label.className = styles.label;
    label.textContent = marker.label;
    const close = document.createElement("button");
    close.type = "button";
    close.className = styles.close;
    close.setAttribute("aria-label", "Dismiss marker");
    close.textContent = "×";
    close.addEventListener("click", () => dismissRef.current?.());
    chip.append(label, close);
    const pin = document.createElement("div");
    pin.className = styles.pin;
    pin.innerHTML = PIN;
    el.append(chip, pin);

    const handle = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([marker.lng, marker.lat])
      .addTo(map);

    // Escape dismisses — unless something closer already consumed the
    // press (the search dropdown prevents default when it closes).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) dismissRef.current?.();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      handle.remove();
    };
    // The map ref is a stable holder, not a reactive input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marker]);
}

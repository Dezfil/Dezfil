/**
 * Builder status bar: pure formatting for the live readouts — cursor
 * coordinates, zoom, viewport bbox — plus a tiny subscription channel so the
 * canvas can stream view state to the bar without re-rendering the whole
 * builder every animation frame. The formatted strings double as the copy
 * payloads: bare comma-separated numbers, ready for a SQL editor.
 * Dependency-free — this reaches the client bundle.
 */

import type { Bounds } from "./geo-bounds";

/** Live view state the canvas reports; cursor is null off the map. */
export interface MapStatus {
  cursor: { lng: number; lat: number } | null;
  zoom: number;
  /** Camera tilt in integer degrees; absent/0 = flat. */
  pitch?: number;
  bounds: Bounds;
}

/** ToFixed, with the "-0.000…" (and bare "-0") rounding artifact
 * normalized away. */
function fixed(value: number, decimals: number): string {
  const s = value.toFixed(decimals);
  const negativeZero = decimals ? `-0.${"0".repeat(decimals)}` : "-0";
  return s === negativeZero ? s.slice(1) : s;
}

const clampLng = (v: number) => Math.min(180, Math.max(-180, v));
const clampLat = (v: number) => Math.min(90, Math.max(-90, v));

/**
 * Wrap a repeated-world longitude into (-180, 180]. The cursor readouts
 * use this: past the antimeridian the true position is the wrapped
 * one, and a value pinned at ±180 would be a lie. The bbox keeps the
 * clamp — a SQL filter wants a valid WGS84 window, not a wrapped one.
 */
const wrapLng = (v: number) => {
  const w = ((((v + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
};

/**
 * The visible bounds as [w, s, e, n], clamped to valid WGS84 — at world zoom
 * the map reports longitudes past ±180 (the world repeats), which would
 * paste garbage into a SQL filter.
 */
export function clampBounds(
  bounds: Bounds,
): [number, number, number, number] {
  const [[w, s], [e, n]] = bounds;
  return [clampLng(w), clampLat(s), clampLng(e), clampLat(n)];
}

/**
 * Wrap, round, and re-canonicalize a longitude for display. Rounding
 * can undo the wrap at the seam — 180.25 wraps to -179.75 and rounds to
 * -180 at zero decimals, -179.999999 rounds to -180 at five — so the
 * canonical (-180, 180] interval is restored after rounding, not before.
 */
function fixedLng(lng: number, decimals: number): string {
  const rounded = Number(wrapLng(lng).toFixed(decimals));
  return fixed(rounded === -180 ? 180 : rounded, decimals);
}

/** "lng, lat" to 5 decimals (~1 m) — longitude first, the SQL point order. */
export function formatCoords(cursor: { lng: number; lat: number }): string {
  return `${fixedLng(cursor.lng, 5)}, ${fixed(clampLat(cursor.lat), 5)}`;
}

/** MapLibre's tile size — the term that turns zoom into degrees/pixel. */
const TILE_SIZE = 512;

/**
 * Decimal places for the reader's coordinate readout at a given zoom,
 * derived from what a pixel actually resolves: the largest count whose
 * step (10^-d degrees) is still at least one pixel's worth of longitude
 * at the equator, 360 / (512 · 2^zoom). Coarse at world zoom, fine up
 * close, monotonic by construction, capped at 5 (~1 m — the builder's
 * own ceiling).
 */
export function readerCoordDecimals(zoom: number): number {
  const degreesPerPixel = 360 / (TILE_SIZE * 2 ** zoom);
  const d = Math.floor(Math.log10(1 / degreesPerPixel));
  return Math.min(5, Math.max(0, d));
}

/**
 * The displayed step in degrees at a given zoom. Decimal steps
 * (10^-decimals) once a pixel resolves a degree or finer; below zoom 0
 * — the canvas permits down to -2 for short viewports — a pixel spans
 * more than a degree, which no decimal count can express, so the step
 * grows to the whole-degree count a pixel actually resolves.
 */
export function readerCoordStep(zoom: number): number {
  const degreesPerPixel = 360 / (TILE_SIZE * 2 ** zoom);
  if (degreesPerPixel > 1) return Math.ceil(degreesPerPixel);
  return 10 ** -readerCoordDecimals(zoom);
}

/**
 * "lat, lng" for the published view's readout — latitude first, the
 * order a reader says aloud and a search box accepts. The builder's
 * `formatCoords` above stays longitude-first for SQL; the divergence is
 * deliberate, each surface matching its consumer. Values are quantized
 * to the step a pixel resolves, and the longitude is re-canonicalized
 * after rounding so the seam never reads -180.
 */
export function formatReaderCoords(
  cursor: { lng: number; lat: number },
  zoom: number,
): string {
  const step = readerCoordStep(zoom);
  if (step >= 1) {
    const lat = clampLat(Math.round(clampLat(cursor.lat) / step) * step);
    const lng = Math.round(wrapLng(cursor.lng) / step) * step;
    return `${fixed(lat, 0)}, ${fixed(lng <= -180 ? lng + 360 : lng, 0)}`;
  }
  const d = readerCoordDecimals(zoom);
  return `${fixed(clampLat(cursor.lat), d)}, ${fixedLng(cursor.lng, d)}`;
}

/** Zoom to 2 decimals. */
export function formatZoom(zoom: number): string {
  return fixed(zoom, 2);
}

/** "w, s, e, n" to 4 decimals (~10 m), WGS84-clamped. */
export function formatBbox(bounds: Bounds): string {
  return clampBounds(bounds)
    .map((v) => fixed(v, 4))
    .join(", ");
}

/**
 * Single-value channel: the canvas emits, the bar subscribes. The rest of
 * the builder never re-renders on view changes — only the subscriber does.
 */
export interface StatusChannel {
  emit(status: MapStatus): void;
  subscribe(onChange: () => void): () => void;
  get(): MapStatus | null;
}

export function createStatusChannel(): StatusChannel {
  let current: MapStatus | null = null;
  const listeners = new Set<() => void>();
  return {
    emit(status) {
      current = status;
      for (const l of listeners) l();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    get: () => current,
  };
}

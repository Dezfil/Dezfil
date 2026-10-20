"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { attachIdleStamp } from "./idle-stamp";
import { createPaintedStyleStamp } from "./painted-style";

/** A plain-background style shown while/if basemap tiles are unreachable —
 * data layers still render. Degrade, don't break. */
export const emptyStyle = (color: string): maplibregl.StyleSpecification => ({
  version: 8,
  // The explicit marker: consumers must identify the
  // fallback by this, never by its shape — a genuine style of one
  // background layer must not read as the fallback.
  metadata: { "dezfil:fallback": true },
  sources: {},
  layers: [
    {
      id: "bg",
      type: "background",
      paint: { "background-color": color },
    },
  ],
});

/** Whether a loaded style is the offline fallback above. */
export function isFallbackStyle(style: {
  metadata?: unknown;
}): boolean {
  const metadata = style.metadata as Record<string, unknown> | undefined;
  return metadata?.["dezfil:fallback"] === true;
}

/**
 * The basemap style lifecycle, extracted from the shared canvas: the
 * in-place style swap when the choice changes, the offline fallback on
 * load failure, and a reactive fallback background — a theme switch
 * recolors an already-failed canvas even when the style URL itself does
 * not change (an explicit basemap or an overridden Auto). Failure is
 * remembered per style URL, so switching basemaps retries.
 */
export function useBasemapStyle(
  map: React.RefObject<maplibregl.Map | null>,
  basemapUrl: string,
  fallbackColor: string,
): { basemapFailed: boolean; attach: (instance: maplibregl.Map) => void } {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const basemapFailed = failedUrl !== null && failedUrl === basemapUrl;

  // The error handler is bound once at attach; it reads current props
  // through refs so basemap changes apply without re-initializing the map.
  const basemapUrlRef = useRef(basemapUrl);
  useEffect(() => {
    basemapUrlRef.current = basemapUrl;
  }, [basemapUrl]);
  const fallbackColorRef = useRef(fallbackColor);
  useEffect(() => {
    fallbackColorRef.current = fallbackColor;
  }, [fallbackColor]);

  // Swap the basemap style in place when the choice changes. Load
  // failures surface through the map's own "error" event below. A URL
  // change clears the failure memory first — switching away and back is
  // a genuine retry, which the reactive fallback below must not clobber.
  //
  // The root style is "pending" from each setStyle until its style.load: any non-source error in that window is the
  // root style's own — fetch failures, parse errors, and the spec's
  // validation errors alike, which no keyword list matched reliably.
  const rootPending = useRef(true);
  const appliedUrl = useRef(basemapUrl);
  useEffect(() => {
    if (!map.current || appliedUrl.current === basemapUrl) return;
    appliedUrl.current = basemapUrl;
    setFailedUrl(null);
    rootPending.current = true;
    map.current.setStyle(basemapUrl);
  }, [map, basemapUrl]);

  // The reactive half: while failed, a fallback recolor re-applies even
  // though no style URL moved.
  useEffect(() => {
    if (!map.current || !basemapFailed) return;
    try {
      map.current.setStyle(emptyStyle(fallbackColor));
    } catch {
      /* Already swapped */
    }
  }, [map, basemapFailed, fallbackColor]);

  // Basemap unreachable (offline / air-gapped) or invalid: fall back to
  // plain background; data layers still render. Only the ROOT style's
  // own failure degrades the canvas: while the
  // root style is pending (setStyle → style.load), any error without a
  // sourceId that doesn't name a sub-resource is the root's — fetch
  // failures, parse errors and the spec's validation errors alike,
  // which no keyword list matched reliably. After load, only an error
  // carrying the style URL itself qualifies.
  const attach = useCallback((instance: maplibregl.Map) => {
    // The host carries which style is painted (the thumbnail capture
    // labels its theme by it): the request that completed, told apart
    // from the latest requested by the load's own shape.
    const stamp = createPaintedStyleStamp(
      instance as unknown as { style: unknown },
      instance.getContainer(),
      basemapUrlRef.current,
    );
    // And whether the map is at rest, its tiles loaded: the painted
    // stamp alone says the style arrived, not that it is drawn.
    attachIdleStamp(instance, instance.getContainer());
    instance.on("style.load", (event) => {
      // The fallback's own load must not clear a pending real failure.
      const fallback = isFallbackStyle(instance.getStyle() ?? {});
      if (!fallback) rootPending.current = false;
      stamp.onStyleLoad(event as { style?: unknown }, basemapUrlRef.current, fallback);
    });
    instance.on("error", (e) => {
      const err = e?.error as
        | { message?: string; url?: string | URL }
        | undefined;
      const msg = String(err?.message ?? "");
      const sourceId = (e as { sourceId?: string }).sourceId;
      const failedResource = err?.url ? String(err.url) : null;
      const styleUrl = basemapUrlRef.current;
      const rootFailure =
        !sourceId &&
        (failedResource === styleUrl ||
          (failedResource === null &&
            rootPending.current &&
            !/tile|glyph|sprite/i.test(msg)));
      if (rootFailure) {
        setFailedUrl(styleUrl);
        try {
          instance.setStyle(emptyStyle(fallbackColorRef.current));
        } catch {
          /* Already swapped */
        }
      }
    });
  }, []);

  return { basemapFailed, attach };
}

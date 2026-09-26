"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Theme } from "@/components/theme";
import {
  BASEMAP_FALLBACKS,
  type BasemapKey,
  type BasemapStyle,
} from "@/lib/basemap";
import { effectiveBasemap } from "@/lib/basemap-effective";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { CustomBasemap } from "@/lib/metadata/maps";
import type { SnapshotCapture, SnapshotHandle } from "../map/capture";
import { composeOverGround, renderOffscreenGround } from "../map/offscreen-ground";
import {
  createThumbnailRunner,
  mintThumbnailCycle,
  type ThumbnailCyclePlan,
  type ThumbnailRunner,
} from "./thumbnail-cycle";

/**
 * Snapshot capture wiring, out of MapBuilder — the decomposition habit's
 * at-touch slice for the capture surface this feature works on. After
 * saved changes settle (2.5s), the canvas composite becomes the maps
 * screen's card image. Fire-and-forget — a failed capture or upload never
 * surfaces, never blocks; the next edit simply tries again. A map whose
 * basemap follows the theme takes a second image for the other theme,
 * through the cycle runner and its gates; the wiring here only decides
 * whether the map is such a map.
 */

/** The least time between two offscreen grounds starting. */
const GROUND_FLOOR_MS = 10_000;
/** How long a ground may take before the cycle gives up. */
const GROUND_TIMEOUT_MS = 20_000;

export interface ThumbnailTheming {
  theme: Theme;
  /** The deployment default, server-injected. */
  basemapUrl: string;
  /** Deployment override (DEZFIL_BASEMAP_URL) — pins Auto in both themes. */
  basemapOverrideUrl: string | null;
  /** The styles this instance offers, server-injected. */
  basemaps?: BasemapStyle[];
}

/** The slice of the map record the theming decision reads. */
export interface ThumbnailMapBasemap {
  basemap: BasemapKey | null;
  customBasemap: CustomBasemap | null;
  basemapLayers: BasemapLayers | null;
}

/** Whether, and how, this capture takes a second image: only a genuine
 * Auto follows the theme; the other theme's style is what the live
 * canvas would load after a toggle. */
export function thumbnailCyclePlan(
  map: ThumbnailMapBasemap,
  theming: ThumbnailTheming,
): ThumbnailCyclePlan {
  const live = effectiveBasemap({
    key: map.basemap,
    custom: map.customBasemap,
    theme: theming.theme,
    overrideUrl: theming.basemapOverrideUrl,
    defaultUrl: theming.basemapUrl,
    basemaps: theming.basemaps,
  });
  if (!live.followsTheme) return { themed: null };
  const otherTheme: Theme = theming.theme === "light" ? "dark" : "light";
  const other = effectiveBasemap({
    key: map.basemap,
    custom: map.customBasemap,
    theme: otherTheme,
    overrideUrl: theming.basemapOverrideUrl,
    defaultUrl: theming.basemapUrl,
    basemaps: theming.basemaps,
  });
  return {
    themed: {
      theme: theming.theme,
      live: {
        theme: theming.theme,
        styleUrl: live.url,
        fallbackColor: BASEMAP_FALLBACKS[theming.theme],
      },
      other: {
        theme: otherTheme,
        styleUrl: other.url,
        fallbackColor: BASEMAP_FALLBACKS[otherTheme],
      },
      basemapLayers: map.basemapLayers,
      basemapKind: live.kind,
    },
  };
}

export function useThumbnailCapture(
  mapId: string,
  /** The map state — any new identity refreshes the snapshot, and a
   * falsy map schedules nothing. */
  map: ThumbnailMapBasemap | null,
  /** The layer renders — any new identity refreshes the snapshot. */
  renders: unknown,
  theming: ThumbnailTheming,
): SnapshotHandle {
  const snapshotRef = useRef<SnapshotCapture | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The plan is read when the timer fires, never when it is armed: the
  // theme or the basemap may have moved in the meantime.
  const planRef = useRef<ThumbnailCyclePlan>({ themed: null });
  const { theme, basemapUrl, basemapOverrideUrl, basemaps } = theming;
  useEffect(() => {
    planRef.current = map
      ? thumbnailCyclePlan(map, {
          theme,
          basemapUrl,
          basemapOverrideUrl,
          basemaps,
        })
      : { themed: null };
  }, [map, theme, basemapUrl, basemapOverrideUrl, basemaps]);
  const onSnapshotHandle = useCallback((capture: SnapshotCapture | null) => {
    snapshotRef.current = capture;
  }, []);
  // One runner per map, made outside render so its closures read the
  // refs in event time; disposed with the map, abandoning a running ground.
  const runnerRef = useRef<ThumbnailRunner | null>(null);
  useEffect(() => {
    const runner = createThumbnailRunner(
      {
        capture: async () => (await snapshotRef.current?.()) ?? null,
        upload: async (query, blob) => {
          // The address is one literal so the API parity scan reads it; a
          // single write's empty query leaves a bare "?" the route reads as none.
          const response = await fetch(`/api/maps/${mapId}/thumbnail?${query}`, {
            method: "PUT",
            headers: { "content-type": "image/png" },
            body: blob,
          });
          return response.ok;
        },
        renderGround: renderOffscreenGround,
        compose: composeOverGround,
        hidden: () => document.hidden,
        mintCycle: mintThumbnailCycle,
      },
      { floorMs: GROUND_FLOOR_MS, timeoutMs: GROUND_TIMEOUT_MS },
    );
    runnerRef.current = runner;
    return () => {
      runner.dispose();
      if (runnerRef.current === runner) runnerRef.current = null;
    };
  }, [mapId]);
  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
    snapshotTimer.current = setTimeout(() => {
      snapshotTimer.current = null;
      void runnerRef.current?.run(planRef.current);
    }, 2500);
  }, []);

  // Anything that lands in map state or a layer render refreshes the
  // snapshot — including the initial load, so stale thumbnails heal on
  // open (behavior preserved verbatim from MapBuilder).
  useEffect(() => {
    if (map) scheduleSnapshot();
  }, [map, renders, scheduleSnapshot]);
  // Unmount just drops a pending capture.
  useEffect(
    () => () => {
      if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
    },
    [],
  );

  return onSnapshotHandle;
}

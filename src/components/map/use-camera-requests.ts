"use client";

import { useEffect, type RefObject } from "react";
import type * as maplibregl from "maplibre-gl";
import type { Bounds } from "@/lib/geo-bounds";

/**
 * The canvas's camera requests, out of MapCanvas per the decomposition
 * rule. The fit contract is unchanged and shared with the published
 * viewer: a new `fitBounds` object animates a bounds fit,
 * timeline-aware, without flattening the camera. Point flights are the
 * builder-only addition: a new `flyTo` object flies to a point at its
 * requested zoom — a search result's close-zoom landing.
 */

export interface FlyRequest {
  lng: number;
  lat: number;
  zoom: number;
}

export function useCameraRequests({
  mapRef,
  fitBounds,
  flyTo,
  timelineOpenRef,
}: {
  mapRef: RefObject<maplibregl.Map | null>;
  fitBounds: Bounds | null | undefined;
  flyTo: FlyRequest | null | undefined;
  timelineOpenRef: RefObject<boolean>;
}): void {
  // Fit-to-bounds when requested. With the timeline widget open, the frame
  // keeps clear of it — otherwise the data's southern edge (and the
  // playback action) hides behind it.
  useEffect(() => {
    if (fitBounds && mapRef.current) {
      mapRef.current.fitBounds(fitBounds, {
        padding: timelineOpenRef.current
          ? { top: 64, left: 64, right: 64, bottom: 150 }
          : 64,
        maxZoom: 15,
        // Fit frames the data without flattening the camera: maplibre
        // resets bearing and pitch to 0 unless told otherwise.
        duration: 900,
        bearing: mapRef.current.getBearing(),
        pitch: mapRef.current.getPitch(),
      });
    }
    // The refs are stable holders, not reactive inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitBounds]);

  useEffect(() => {
    if (flyTo && mapRef.current) {
      mapRef.current.flyTo({
        center: [flyTo.lng, flyTo.lat],
        zoom: flyTo.zoom,
        duration: 900,
        bearing: mapRef.current.getBearing(),
        pitch: mapRef.current.getPitch(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo]);
}

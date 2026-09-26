"use client";

import { useCallback, useState } from "react";
import type { Bounds } from "@/lib/geo-bounds";
import type { LiveDim } from "@/lib/live-filters";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { FlyRequest } from "@/components/map/use-camera-requests";
import type { SearchMarkerRequest } from "@/components/map/use-search-marker";
import type { SearchAction } from "./search/rows";
import type { LayerRenderData } from "./render-data";
import { useFit } from "./use-fit";

/**
 * The builder's camera state (at-touch slice out of MapBuilder): the
 * fit-bounds request the canvas consumes, the fit actions (unchanged,
 * via the fit hook), and the search additions — point flights and the
 * transient marker, driven by a search selection's per-class action
 * Located results fly or fit with the marker; a layer row fits
 * through the same honest fit path every other fit uses, with no marker.
 */
export function useCameraState(fit: {
  rendersRef: React.RefObject<Record<string, LayerRenderData>>;
  serverMapRef: React.RefObject<MapWithLayers | null>;
  dims: Record<string, LiveDim[]>;
  staged: Record<string, LayerRenderData | undefined>;
  cameraRef: React.RefObject<{
    liveRanges: () => Record<string, [number, number][]>;
  } | null>;
  /** The host owns the fit-bounds state — import flows request fits
   * before this hook's other inputs exist. */
  setFitBounds: (bounds: Bounds) => void;
  fail: (lane: "fit", message: string) => void;
  clearFailure: (lane: "fit") => void;
}) {
  const [flyTo, setFlyTo] = useState<FlyRequest | null>(null);
  const [searchMarker, setSearchMarker] =
    useState<SearchMarkerRequest | null>(null);

  const { fitAll, fitLayer } = useFit(fit);
  const { setFitBounds } = fit;

  const dismissSearchMarker = useCallback(() => setSearchMarker(null), []);

  const onSearchAction = useCallback(
    (action: SearchAction) => {
      if (action.type === "fit-layer") {
        // A layer fit shows no marker — including a survivor from
        // an earlier located selection, which would mislead over the
        // framed extent.
        setSearchMarker(null);
        fitLayer(action.layerId);
        return;
      }
      // A located selection moves the marker; a fresh object re-flies
      // even to the same point.
      setSearchMarker({ ...action.marker });
      if (action.type === "fly") {
        setFlyTo({ lng: action.lng, lat: action.lat, zoom: action.zoom });
      } else {
        const [w, s, e, n] = action.bounds;
        setFitBounds([[w, s], [e, n]]);
      }
    },
    [fitLayer, setFitBounds],
  );

  return {
    fitAll,
    fitLayer,
    flyTo,
    searchMarker,
    dismissSearchMarker,
    onSearchAction,
  };
}

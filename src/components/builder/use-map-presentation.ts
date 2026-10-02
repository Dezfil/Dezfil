"use client";

import {
  useCallback,
  useMemo,
  useState,
  type RefObject,
} from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { Corner } from "@/lib/corners";
import type { Bounds } from "@/lib/geo-bounds";
import { effectiveStyle, type LayerFilter } from "@/lib/viz";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";
import type { WidgetValues } from "@/lib/widget-service";
import { createStatusChannel } from "@/lib/map-status";
import {
  liveFilters as liveFilterRule,
  LIVE_FILTER_SLOTS,
  type LiveDim,
} from "@/lib/live-filters";
import { readApiFailure } from "../api";
import type { HeatmapPreviewSetter, RenderedLayer } from "../map/MapCanvas";
import type { CameraHandle } from "../map/camera-handle";
import { useLiftClearance } from "../map/use-lift-clearance";
import { useLegendPlacement } from "../map/use-legend-placement";
import { NETWORK_FAILURE, type EndpointResult } from "../widgets/dashboard-state";
import {
  useWidgetDashboard,
  type DashboardEndpoints,
  type DashboardLayer,
} from "../widgets/use-widget-dashboard";
import type { AppearanceDraft } from "./builder-shell-state";
import type { LegendLiveText } from "./LegendTab";
import type { LayerRenderData } from "./render-data";
import type { QuerySliderDraft } from "./use-query-slider-preview";
import { useBuilderWidgets } from "./use-builder-widgets";
import { useCameraState } from "./use-camera-state";
import { useLegendLayers } from "./use-legend-layers";
import { useLiveFilters } from "./use-live-filters";

/**
 * What the builder shows of a map to a reader, out of `MapBuilder.tsx`
 * under the decomposition rule: the layers as drawn, the legend's inputs,
 * the widgets with their values and selections, the live filters, and
 * the camera with its fitting. `MapPresentation` draws it.
 *
 * It is mountable on the data a reader has: the map record, its layers'
 * render data and the data endpoints. Everything authoring adds arrives
 * as an optional input and changes nothing when absent: the slider and
 * appearance drafts drawn over the stored layers, the Legend tab's live
 * text, the widget editor's unsaved draft, the export card's wider widget
 * set, and the heatmap preview channel the style panel drives. Writes
 * never happen here; persisting the camera, the timeline and every edit
 * stays with the host.
 */

const NO_SLIDER_DRAFTS: Record<string, QuerySliderDraft> = {};
const NO_APPEARANCE_DRAFTS: Record<string, AppearanceDraft> = {};
const NO_LEGEND_LIVE: Record<string, LegendLiveText> = {};

/** One map's widget data endpoints in the workspace: the batched values
 * (carrying an unsaved widget draft for server-side computation when
 * there is one) and the settle re-render under selections. Both are
 * reads, and nothing tracks them as saves. */
export function mapWidgetEndpoints(
  mapId: string,
  draft: MapWidget | null,
): DashboardEndpoints {
  return {
    values: async (
      selections: WidgetSelection[],
    ): Promise<EndpointResult<WidgetValues>> => {
      try {
        const r = await fetch(`/api/maps/${mapId}/widget-values`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selections,
            ...(draft ? { draft } : null),
          }),
        });
        if (!r.ok) return { ok: false, error: await readApiFailure(r) };
        return { ok: true, data: (await r.json()) as WidgetValues };
      } catch {
        return { ok: false, error: NETWORK_FAILURE };
      }
    },
    settle: async (
      layerId: string,
      filters: LayerFilter[],
    ): Promise<EndpointResult<LayerRenderData>> => {
      try {
        const r = await fetch(`/api/layers/${layerId}/render`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selections: filters }),
        });
        if (!r.ok) return { ok: false, error: await readApiFailure(r) };
        return { ok: true, data: (await r.json()) as LayerRenderData };
      } catch {
        return { ok: false, error: NETWORK_FAILURE };
      }
    },
  };
}

export interface MapPresentationInput {
  map: MapWithLayers | null;
  renders: Record<string, LayerRenderData>;
  /** What fitting reads at press time: the render data and the map as
   * last confirmed, which an optimistic host state can be ahead of. */
  rendersRef: RefObject<Record<string, LayerRenderData>>;
  mapRef: RefObject<MapWithLayers | null>;
  /** The widget values and settle endpoints. */
  endpoints: DashboardEndpoints;
  /** The canvas's camera handle. The host owns it, because its own
   * controls (an export's current view, a tilt slider) read it too. */
  cameraRef: RefObject<CameraHandle | null>;
  /** The host owns the fit-bounds request: a load or an import frames
   * the data before anything here exists. */
  setFitBounds: (bounds: Bounds) => void;
  /** Fitting's failure lane: an extent the server could not give. */
  fail: (lane: "fit", message: string) => void;
  clearFailure: (lane: "fit") => void;
  /** The status pill is the host's choice; the legend's lift reads it. */
  statusPillHidden?: boolean;
  /** Fullscreen moves the stage's corners, so placement re-measures. */
  fullscreen?: boolean;
  /** Where the legend stands while the author has not placed it. */
  defaultLegendCorner?: Corner;
  /** Authoring: query-slider previews drawn over the stored layers. */
  sliderDrafts?: Record<string, QuerySliderDraft>;
  /** Authoring: appearance drafts drawn over the stored layers and legend. */
  appearanceDrafts?: Record<string, AppearanceDraft>;
  /** Authoring: Legend-tab text mirrored to the legend as it is typed. */
  legendLive?: Record<string, LegendLiveText>;
  /** Authoring: the open widget editor's unsaved widget. */
  widgetDraft?: MapWidget | null;
  /** Authoring: the export card is open, so values are read for every
   * resolvable widget rather than the visible set alone. */
  widenDashboard?: boolean;
  /** Authoring: receives the canvas's heatmap preview channel too. */
  onHeatmapPreviewSetter?: (set: HeatmapPreviewSetter) => void;
}

export type MapPresentationState = ReturnType<typeof useMapPresentation>;

export function useMapPresentation({
  map,
  renders,
  rendersRef,
  mapRef,
  endpoints,
  cameraRef,
  setFitBounds,
  fail,
  clearFailure,
  statusPillHidden = false,
  fullscreen = false,
  defaultLegendCorner = "bottom-left",
  sliderDrafts = NO_SLIDER_DRAFTS,
  appearanceDrafts = NO_APPEARANCE_DRAFTS,
  legendLive = NO_LEGEND_LIVE,
  widgetDraft = null,
  widenDashboard = false,
  onHeatmapPreviewSetter: hostHeatmapPreviewSetter,
}: MapPresentationInput) {
  // Compass needle (integer degrees); right-drag rotation moves it, the
  // button eases the view back flat and north-up.
  const [bearing, setBearing] = useState(0);
  // Camera tilt (integer degrees) — drives the tilt toggle's state and the
  // fine pitch slider.
  const [pitch, setPitch] = useState(0);
  const onCameraHandle = useCallback(
    (handle: CameraHandle | null) => {
      cameraRef.current = handle;
    },
    [cameraRef],
  );
  // The bottom corner lifts above the docked timeline only when their
  // horizontal extents would actually collide, as a field round found.
  const [timelineDockEl, setTimelineDockEl] = useState<HTMLElement | null>(
    null,
  );
  const [bottomCornerEl, setBottomCornerEl] = useState<HTMLElement | null>(
    null,
  );
  const [legendCandidateEl, setLegendCandidateEl] =
    useState<HTMLElement | null>(null);
  const [widgetStackEl, setWidgetStackEl] = useState<HTMLElement | null>(null);
  const [creditEl, setCreditEl] = useState<HTMLElement | null>(null);
  const setBottomRightCornerEl = useCallback((node: HTMLElement | null) => {
    setBottomCornerEl(node);
    setLegendCandidateEl(node);
  }, []);
  // A docked bottom-right candidate is the hidden corner itself. Its lift
  // only repositions that probe for placement measurement; the visible
  // credit has its own element, measurement, and `creditLift` consumer.
  const cornerLift = useLiftClearance(timelineDockEl, bottomCornerEl);
  // The credit shares the bottom band the dock reclaims when the status
  // pill hides; CSS applies its lift only in that state.
  const creditLift = useLiftClearance(timelineDockEl, creditEl);
  // Live canvas → status bar stream; only the bar re-renders.
  const [statusChannel] = useState(createStatusChannel);

  const renderedLayers: RenderedLayer[] = useMemo(() => {
    if (!map) return [];
    return map.layers.map((l) => {
      const r = renders[l.id];
      const preview = sliderDrafts[l.id];
      const appearance = appearanceDrafts[l.id];
      const viz = appearance?.viz ?? preview?.viz ?? l.viz;
      const layerStyle = appearance?.style ?? l.style;
      const tiles =
        !preview &&
        r?.ok && r.mode === "tiled" && r.tiles?.state === "ready" && r.tiles.url
          ? {
              url: r.tiles.url,
              minZoom: r.tiles.minZoom,
              maxZoom: r.tiles.maxZoom,
            }
          : null;
      return {
        id: l.id,
        // Aggregated layers draw their cells with the viz fill. Bounded
        // previews omit labels so estimates never read as exact.
        style: preview?.approximate
          ? { ...effectiveStyle(layerStyle, viz), label: undefined }
          : effectiveStyle(layerStyle, viz),
        visible: l.visible,
        tooltip: preview?.approximate ? [] : l.tooltip,
        popup: preview?.approximate ? [] : l.popup,
        viz,
        geojson: preview?.geojson ?? (r?.ok ? r.geojson : null),
        tiles,
      };
    });
  }, [map, renders, sliderDrafts, appearanceDrafts]);

  // The legend inputs live in their own module (the at-touch
  // decomposition slice), carrying rendered geometry for the swatch rule.
  const legendLayers = useLegendLayers({
    map,
    renders,
    legendLive,
    appearanceDrafts,
  });

  // Live filters: orchestration lives beside the builder, not in it — see
  // use-live-filters.ts.
  const live = useLiveFilters({ map, renders });
  const registerLiveHeatmapPreview = live.onHeatmapPreviewSetter;
  const onHeatmapPreviewSetter = useCallback(
    (set: HeatmapPreviewSetter) => {
      hostHeatmapPreviewSetter?.(set);
      registerLiveHeatmapPreview(set);
    },
    [hostHeatmapPreviewSetter, registerLiveHeatmapPreview],
  );

  // Widgets & cross-filtering: the dashboard hook owns selection state
  // and fans enforcement out — GPU dimensions for layers that draw
  // features, settle re-renders for computed results. Value reads are
  // batched and never tracked as saves (they are reads). An open widget
  // editor's unsaved state overlays the stored list so the rail previews
  // every edit live — titles instantly, numbers through the same batched
  // read, which carries the draft for server-side computation.
  const { resolvableWidgets, visibleWidgets } = useBuilderWidgets(
    map,
    widgetDraft,
  );
  const railVisible = visibleWidgets.length > 0;
  const legendCorner = map?.legendCorner ?? defaultLegendCorner;
  const legendPlacement = useLegendPlacement(
    legendCorner,
    railVisible,
    widgetStackEl,
    legendCandidateEl,
    `${cornerLift}:${creditLift && statusPillHidden}:${fullscreen}`,
  );
  const legendDocked = legendPlacement.docked;
  const dashboardLayers: DashboardLayer[] = useMemo(
    () =>
      (map?.layers ?? []).map((l) => {
        const r = renders[l.id];
        return {
          id: l.id,
          vizType: l.viz.type,
          liveFiltered: !!(r?.ok && r.liveFiltered),
          storedDims: liveFilterRule(
            l.viz,
            l.filters,
            map?.timeline?.layerId === l.id ? map.timeline.field : null,
          ).length,
        };
      }),
    [map, renders],
  );
  const layersRevision = useMemo(
    () => (map?.layers ?? []).map((l) => `${l.id}:${l.updatedAt}`).join("|"),
    [map],
  );
  const dash = useWidgetDashboard({
    // While the export card is open the batch widens to every resolvable
    // widget, so a hidden widget toggled on for the export previews (and
    // exports) real values, not an empty card. The rail keeps rendering
    // only the visible set.
    widgets: widenDashboard ? resolvableWidgets : visibleWidgets,
    layers: dashboardLayers,
    endpoints,
    revision: layersRevision,
  });
  // Stored live filters and widget selections share the fixed GPU slots.
  const canvasDims = useMemo(() => {
    const out: Record<string, LiveDim[]> = { ...live.canvas };
    for (const [id, dims] of Object.entries(dash.selectionDims)) {
      out[id] = [...(out[id] ?? []), ...dims].slice(0, LIVE_FILTER_SLOTS);
    }
    return out;
  }, [live.canvas, dash.selectionDims]);
  // Computed layers draw their settle re-render while selections constrain
  // them; the canonical render returns when selections clear.
  const stagedLayers = useMemo(
    () =>
      renderedLayers.map((rl) => {
        const settle = dash.settleRenders[rl.id];
        return settle?.ok && settle.geojson
          ? { ...rl, geojson: settle.geojson, tiles: null }
          : rl;
      }),
    [renderedLayers, dash.settleRenders],
  );
  // Fitting — beside the builder, per the decomposition rule. It measures
  // what is drawn, defers a constrained tiled layer to the server, and
  // ignores an answer its constraints have outrun; it sits here because
  // it reads what the canvas is drawing, settled above.
  const { fitAll, fitLayer, flyTo, searchMarker, dismissSearchMarker,
    onSearchAction } = useCameraState({
    rendersRef, serverMapRef: mapRef, dims: canvasDims, staged: dash.settleRenders,
    cameraRef, setFitBounds, fail, clearFailure,
  });

  const widgetRecords = useMemo(() => {
    const rows = dash.values?.layers ?? [];
    if (rows.length === 0) return null;
    return {
      count: rows.reduce((s, r) => s + r.count, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    };
  }, [dash.values]);

  return {
    stagedLayers,
    canvasDims,
    legendLayers,
    live,
    onHeatmapPreviewSetter,
    bearing,
    setBearing,
    pitch,
    setPitch,
    onCameraHandle,
    fitAll,
    fitLayer,
    flyTo,
    searchMarker,
    dismissSearchMarker,
    onSearchAction,
    resolvableWidgets,
    visibleWidgets,
    railVisible,
    dash,
    widgetRecords,
    legendCorner,
    legendPlacement,
    legendDocked,
    cornerLift,
    creditLift,
    setTimelineDockEl,
    setBottomCornerEl,
    setBottomRightCornerEl,
    setWidgetStackEl,
    setCreditEl,
    statusChannel,
    statusPillHidden,
  };
}

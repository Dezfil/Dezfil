"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  MapWithLayers,
  Layer,
  Viewport,
} from "@/lib/metadata/maps";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import {
  isAggregated,
  vizAppearanceOnly,
  type AggregatedViz,
  type CellElevation,
  type ClusterViz,
  type HeatmapViz,
  type LayerFilter,
  type LayerViz,
  type OdViz,
} from "@/lib/viz";
import { BASEMAPS, BASEMAP_FALLBACKS, type AttributionLine, type BasemapStyle } from "@/lib/basemap";
import { builderBasemap } from "./builder-basemap";
import type { BasemapLayerGroup } from "@/lib/basemap-layers";
import type { Corner } from "@/lib/corners";
import { useTheme } from "@/components/theme";
import type { Bounds } from "@/lib/geo-bounds";
import type { HeatmapPreviewSetter } from "../map/MapCanvas";
import type { CameraHandle } from "../map/camera-handle";
import {
  mergeHeatmapControl,
  type HeatmapControlField,
} from "@/lib/heatmap-quality";
import { BuilderStageControls } from "./BuilderStageControls";
import { useBuilderLayerActions } from "./use-builder-layer-actions";
import { DocumentEditorContext } from "../document-editor-context";
import { useDrawIntegration } from "./draw/use-draw-integration";
import { usePublishedThemeSync } from "./use-published-theme-sync";
import { SearchControl } from "./search/SearchControl";
import { BuilderLoadFailure, BuilderLoading } from "./BuilderFallback";
import { TabPanel, Tabs } from "../ui/Tabs";
import { useLegendTab } from "./use-legend-tab";
import { offerLayer } from "./drawer/pick-mode";
import {
  type AppearanceDraft,
  statusPillStore,
  RAIL_TABS,
  type RailTab,
} from "./builder-shell-state";
import { useLayerRenders } from "./use-layer-renders";
import { useLayerSourceCoordinator } from "./use-layer-source-coordinator";
import { AddLayerTrigger } from "./add-layer/AddLayerCatalog";
import { CatalogHost } from "./add-layer/CatalogHost";
import { HeaderChrome } from "./BuilderChrome";
import { BuilderHelpers, useBuilderHelpers } from "./BuilderHelpers";
import { ExportImageCard } from "./export/ExportImageCard";
import { buildExportStage } from "./export/export-stage";
import { useExportCard } from "./export/use-export-card";
import { useThumbnailCapture } from "./use-thumbnail-capture";
import { useWidgetListActions } from "./use-widget-list-actions";
import { LayerList } from "./LayerList";
import { StylePanel } from "./StylePanel";
import { BasemapTab } from "./BasemapTab";
import { useLabelCounts } from "./use-label-counts";
import {
  LegendTab,
  type LegendFocus,
} from "./LegendTab";
import type { LegendTextTarget } from "../map/LegendPanel";
import { useTimeline } from "./use-timeline";
import { WidgetsTab, type WidgetFocus } from "./WidgetsTab";
import type { MapWidget } from "@/lib/widgets";
import { MapPresentation } from "./MapPresentation";
import {
  mapWidgetEndpoints,
  useMapPresentation,
} from "./use-map-presentation";
import { useQuerySliderPreview } from "./use-query-slider-preview";
import { useBuilderMutations, useBuilderReload } from "./use-builder-mutations";
import { useBuilderCamera } from "./use-builder-camera";
import { useLayerDataDownloads } from "./use-layer-data-downloads";
import { BuilderFailureNotes } from "./BuilderFailureNotes";
import styles from "./MapBuilder.module.css";
import { withBuilderRecovery } from "./BuilderRecovery";
import { BuilderStaleNotice } from "./BuilderStaleNotice";
import { BuilderSavedState, LegendUnsavedDot } from "./UnsavedFields";
import { useStyleAppearanceCommit } from "./use-style-appearance-commit";
import { nextStyleDraft } from "./style-draft";

function BuilderEditor({
  recoverySeed, onRecovered,
  mapId,
  initialLayerId = null,
  basemapUrl,
  basemapOverrideUrl = null,
  basemapOverrideAttribution = [],
  basemaps = BASEMAPS,
}: import("./BuilderRecovery").BuilderRecoveryProps & {
  mapId: string;
  /** Layer to open selected — the promotion flows arrive
   * with the landed layer's id via the page's search params. */
  initialLayerId?: string | null;
  basemapUrl: string;
  /** Deployment override (DEZFIL_BASEMAP_URL) — pins Auto in both themes. */
  basemapOverrideUrl?: string | null;
  /** That override's credit, and the styles this instance offers, both server-injected. */
  basemapOverrideAttribution?: AttributionLine[];
  basemaps?: BasemapStyle[];
}) {
  const { theme } = useTheme();
  const [map, setMap] = useState<MapWithLayers | null>(null);
  // The detail response's membership — deliberately beside the shared
  // record, never on it (the published-shape exclusion).
  const [mapProjectId, setMapProjectId] = useState<string | null>(null);
  // Render answers, the tile poll and the one ordering rule every
  // answer passes before it is shown (use-layer-renders.ts).
  const { renders, rendersRef, refreshLayer, replaceRenders, removeRender } =
    useLayerRenders();
  const [selectedId, setSelectedId] = useState<string | null>(initialLayerId);
  // Select mode's map half: a picked feature resolves to its owning
  // layer, which the armed picker answers — consumed or refused.
  const offerPickedLayer = useCallback(
    (layerId: string) => {
      const layer = map?.layers.find((l) => l.id === layerId);
      return layer ? offerLayer(layer) : false;
    },
    [map],
  );
  const [fitBounds, setFitBounds] = useState<Bounds | null>(null);
  const [tab, setTab] = useState<RailTab>("layers");
  // The helpers: Tools left, the assistant right, the two stage edges
  // the camera frames against, and the header's door.
  const helpers = useBuilderHelpers(mapId, selectedId);
  const { stageEdges } = helpers;
  // Wheelhouse stage states. They ride on <body> attributes so the shell
  // header and every fixed card can restyle with the map.
  const [mapFull, setMapFull] = useState(false);
  const mapLayerRef = useRef<HTMLDivElement | null>(null);
  // Imperative zoom from the stage stack: the builder renders its own +/−
  // buttons instead of the basemap's native control.
  const zoomHandleRef = useRef<CameraHandle | null>(null);
  // the draw overlay projects through the camera bridge — a state
  // mirror of the ref, because the overlay must re-render when the
  // handle arrives.
  const [drawCamera, setDrawCamera] = useState<CameraHandle | null>(null);
  const statusPillHidden = useSyncExternalStore(
    statusPillStore.subscribe,
    statusPillStore.read,
    () => false,
  );
  useEffect(() => {
    const body = document.body;
    const set = (name: string, on: boolean) =>
      on ? body.setAttribute(name, "") : body.removeAttribute(name);
    set("data-map-full", mapFull);
    set("data-status-pill-hidden", statusPillHidden);
    return () => {
      body.removeAttribute("data-map-full");
      body.removeAttribute("data-status-pill-hidden");
    };
  }, [mapFull, statusPillHidden]);
  const viewportRef = useRef<Viewport | null>(null);
  // The export image card: opened from the header's Export menu. Its
  // live handle leads, while settled and stored fallbacks keep Image
  // available long enough to report a WebGL startup failure.
  const exportCard = useExportCard(
    zoomHandleRef,
    viewportRef,
    mapLayerRef,
    map?.viewport ?? { lng: 0, lat: 0, zoom: 1 },
  );
  const mutations = useBuilderMutations({
    mapId, map, setMap, rendersRef, replaceRenders, setSelectedId, refreshLayer,
  });
  const {
    history, edited, reloadKey, reload, authoritativeLayersRef, truthSeqRef,
    mapFieldEditedAtRef, serverMapRef,
    legendLive, onLegendLive, failures, fail, clearFailure, pendingSaves,
    track, patchMap, patchLayer, applyHistory,
  } = mutations;
  const persistViewport = useBuilderCamera(mapId, viewportRef, track);

  const layerDownloads = useLayerDataDownloads(mapId, map?.layers ?? []);

  // A published map follows the mode its author composes in.
  usePublishedThemeSync({
    mapId,
    request: mutations.request,
    publishToken: map?.publishToken,
    theme,
    onFailure: useCallback(
      (message: string) => fail("publish", message),
      [fail],
    ),
    onSuccess: useCallback(() => clearFailure("publish"), [clearFailure]),
  });

  // Layer-source coordination: the Add-data dialog's state, the
  // post-import auto-layer with focus-window framing and notices, and
  // the raw-SQL create path — extracted beside MapBuilder.
  const layerSources = useLayerSourceCoordinator({
    mapId,
    request: mutations.request,
    reload,
    edited,
    setSelectedId,
    setFitBounds,
    patchLayer,
    projectId: mapProjectId,
  });
  const { importFocusRef, importNotice, showNotice, openCatalogAdd, openCatalogEdit } =
    layerSources;

  const heatmapPreviewSetterRef = useRef<HeatmapPreviewSetter | null>(null);
  const heatmapPreviewVersionRef = useRef<Record<string, number>>({});
  const heatmapFieldVersionRef = useRef<
    Record<string, Partial<Record<HeatmapControlField, number>>>
  >({});
  const heatmapDraftVizRef = useRef<Record<string, HeatmapViz>>({});
  const aggregationPreviewVersionRef = useRef<Record<string, number>>({});
  const [appearanceDrafts, setAppearanceDrafts] = useState<
    Record<string, AppearanceDraft>
  >({});
  const appearanceDraftRef = useRef<Record<string, AppearanceDraft>>({});
  const appearancePreviewVersionRef = useRef<Record<string, number>>({});
  const { labelCounts, onLabelCounts } = useLabelCounts();
  // Which groups the loaded style yields — the panel marks the rest
  // "not in this style" while a custom style is active.
  const [loadedBasemapGroups, setLoadedBasemapGroups] = useState<
    BasemapLayerGroup[] | null
  >(null);
  // Stable identity: the preview hook's worker effect depends on this
  // callback, so a fresh closure per render would tear the worker down
  // mid-flight and wedge its queue.
  const onPreviewError = useCallback(
    (message: string) => fail("preview", message),
    [fail],
  );
  const onPreviewSuccess = useCallback(
    () => clearFailure("preview"),
    [clearFailure],
  );
  const {
    drafts: querySliderDrafts,
    approximate: querySliderApproximate,
    prepare: prepareQuerySliderPreview,
    preview: runQuerySliderPreview,
    reconcile: reconcileQuerySliderPreview,
    end: endQuerySliderPreview,
  } = useQuerySliderPreview({
    onError: onPreviewError,
    onSuccess: onPreviewSuccess,
  });

  /** Keep the worker draft through the authoritative React/deck paint.
   * This avoids a blank frame between fresh render data and layer teardown. */
  const settleQuerySliderPreview = useCallback(
    (layerId: string) => {
      const layer = authoritativeLayersRef.current[layerId];
      const render = rendersRef.current[layerId];
      if (layer && render?.ok && render.geojson) {
        reconcileQuerySliderPreview(layer, render.geojson);
      } else {
        endQuerySliderPreview(layerId);
      }
    },
    [authoritativeLayersRef, rendersRef, endQuerySliderPreview, reconcileQuerySliderPreview],
  );

  useBuilderReload({
    mapId, mutations, recoverySeed, importFocusRef, setMap, setMapProjectId, replaceRenders, setFitBounds,
  });

  // The Legend tab's write wiring lives in use-legend-tab since 0119.
  const legendTab = useLegendTab({
    patchMap,
    patchLayer,
    setMap,
    truthSeqRef,
    mapFieldEditedAtRef,
  });

  // Snapshot capture: wiring lives in its own hook (the at-touch slice
  // for the capture surface).
  const onSnapshotHandle = useThumbnailCapture(mapId, map, renders, { theme, basemapUrl, basemapOverrideUrl, basemaps });

  // Undo/redo is its own serialized lane; its repaint is a render
  // replacement, so a superseded repaint never lands.

  // Direct manipulation: the corner a drag would drop in, and one-shot
  // focus requests from clicking overlay text on the canvas. The note
  // surface retired into note widgets.
  const [dragPreview, setDragPreview] = useState<Corner | null>(null);
  const [legendFocus, setLegendFocus] = useState<LegendFocus | null>(null);
  // One-shot request from a rail card's ⋮ to open its editor.
  const [widgetFocus, setWidgetFocus] = useState<WidgetFocus | null>(null);


  const previewHeatmapViz = useCallback(
    (
      layerId: string,
      viz: LayerViz,
      field: HeatmapControlField,
    ) => {
      if (viz.type !== "heatmap") return;
      const authoritative = authoritativeLayersRef.current[layerId]?.viz;
      const base =
        heatmapDraftVizRef.current[layerId] ??
        (authoritative?.type === "heatmap" ? authoritative : viz);
      const draft = mergeHeatmapControl(base, viz, field);
      const version = (heatmapPreviewVersionRef.current[layerId] ?? 0) + 1;
      heatmapPreviewVersionRef.current[layerId] = version;
      heatmapFieldVersionRef.current[layerId] = {
        ...heatmapFieldVersionRef.current[layerId],
        [field]: version,
      };
      heatmapDraftVizRef.current[layerId] = draft;
      heatmapPreviewSetterRef.current?.(layerId, "viz", true, { viz: draft });
    },
    [authoritativeLayersRef],
  );

  const commitHeatmapViz = useCallback(
    (
      layerId: string,
      viz: LayerViz,
      field: HeatmapControlField,
    ): Promise<boolean> => {
      if (viz.type !== "heatmap") return Promise.resolve(false);
      const version = heatmapPreviewVersionRef.current[layerId] ?? 0;
      const fieldVersion = heatmapFieldVersionRef.current[layerId]?.[field];
      const result = (async () => {
        const currentLayer = authoritativeLayersRef.current[layerId];
        const current = currentLayer?.viz;
        const nextViz =
          current?.type === "heatmap"
            ? mergeHeatmapControl(current, viz, field)
            : viz;
        const updated =
          current?.type === "heatmap" && current[field] === nextViz[field]
            ? currentLayer
            : await patchLayer(layerId, (accepted) => ({ viz: accepted.viz.type === "heatmap" ? mergeHeatmapControl(accepted.viz, viz, field) : nextViz }), {
                skipRefresh: true,
                separateHistoryStep: true,
              });
        if (mutations.sequence.stale) return false;
        const authoritative = updated ?? authoritativeLayersRef.current[layerId];
        if (heatmapPreviewVersionRef.current[layerId] === version) {
          delete heatmapDraftVizRef.current[layerId];
          delete heatmapFieldVersionRef.current[layerId];
          if (authoritative?.viz.type === "heatmap") {
            heatmapPreviewSetterRef.current?.(layerId, "viz", false, {
              viz: authoritative.viz,
              accepted: updated !== null,
            });
          }
        } else if (
          authoritative?.viz.type === "heatmap" &&
          heatmapDraftVizRef.current[layerId]
        ) {
          // A newer interaction is still previewing. Reconcile only this
          // completed field; preserve a newer draft of the same field.
          if (heatmapFieldVersionRef.current[layerId]?.[field] === fieldVersion) {
            heatmapDraftVizRef.current[layerId] = {
              ...heatmapDraftVizRef.current[layerId],
              [field]: authoritative.viz[field],
            };
          }
          heatmapPreviewSetterRef.current?.(layerId, "viz", true, {
            viz: heatmapDraftVizRef.current[layerId],
          });
        }
        return updated !== null;
      })();
      return result;
    },
    [authoritativeLayersRef, patchLayer, mutations.sequence],
  );

  const previewAggregationViz = useCallback(
    (layer: Layer, viz: AggregatedViz) => {
      aggregationPreviewVersionRef.current[layer.id] =
        (aggregationPreviewVersionRef.current[layer.id] ?? 0) + 1;
      runQuerySliderPreview(layer, viz, layer.filters);
    },
    [runQuerySliderPreview],
  );

  const commitAggregationViz = useCallback(
    (layerId: string, draft: AggregatedViz): Promise<boolean> => {
      const version = aggregationPreviewVersionRef.current[layerId] ?? 0;
      const result = (async () => {
        const current = authoritativeLayersRef.current[layerId]?.viz;
        if (!current || current.type !== draft.type || !isAggregated(current)) {
          if (aggregationPreviewVersionRef.current[layerId] === version) {
            endQuerySliderPreview(layerId);
          }
          return false;
        }
        if (draft.type !== current.type) return false;
        // Both aggregations share one continuous cell size; the
        // elevation rides the same commit lane. A height-only change
        // keeps the fill — the color distribution didn't move — while a
        // cell change still drops it for reclassification.
        const cellChanged = current.cellKm !== draft.cellKm;
        const elevationChanged =
          JSON.stringify(current.elevation ?? null) !==
          JSON.stringify(draft.elevation ?? null);
        const unchanged = !cellChanged && !elevationChanged;
        const next: AggregatedViz = { ...current, cellKm: draft.cellKm };
        if (draft.elevation !== undefined) next.elevation = draft.elevation;
        else delete next.elevation;
        if (cellChanged) delete next.fill;
        const updated = unchanged
          ? authoritativeLayersRef.current[layerId] ?? null
          : await patchLayer(
              layerId,
              { viz: next },
              { separateHistoryStep: true },
            );
        if (mutations.sequence.stale) return false;
        if (aggregationPreviewVersionRef.current[layerId] === version) {
          if (updated && !unchanged) settleQuerySliderPreview(layerId);
          else endQuerySliderPreview(layerId);
        }
        return updated !== null;
      })();
      return result;
    },
    [authoritativeLayersRef, endQuerySliderPreview, patchLayer, settleQuerySliderPreview, mutations.sequence],
  );

  const setAppearanceDraft = useCallback(
    (layerId: string, draft: AppearanceDraft) => {
      appearanceDraftRef.current[layerId] = draft;
      setAppearanceDrafts((current) => ({ ...current, [layerId]: draft }));
    },
    [],
  );

  const clearAppearanceDraft = useCallback((layerId: string) => {
    delete appearanceDraftRef.current[layerId];
    setAppearanceDrafts((current) => {
      if (!(layerId in current)) return current;
      const next = { ...current };
      delete next[layerId];
      return next;
    });
  }, []);

  const previewStyleAppearance = useCallback(
    (layerId: string, partial: Partial<LayerStyle>) => {
      const layer = authoritativeLayersRef.current[layerId];
      if (!layer) return;
      appearancePreviewVersionRef.current[layerId] =
        (appearancePreviewVersionRef.current[layerId] ?? 0) + 1;
      setAppearanceDraft(
        layerId,
        nextStyleDraft(appearanceDraftRef.current[layerId], layer.style, partial, map?.layers.find((l) => l.id === layerId)?.style),
      );
    },
    [authoritativeLayersRef, map, setAppearanceDraft],
  );

  const previewAggregatedFill = useCallback(
    (layerId: string, fill: FillPaint) => {
      const layer = authoritativeLayersRef.current[layerId];
      if (!layer || !isAggregated(layer.viz)) return;
      appearancePreviewVersionRef.current[layerId] =
        (appearancePreviewVersionRef.current[layerId] ?? 0) + 1;
      const prior = appearanceDraftRef.current[layerId];
      const priorViz = prior?.viz;
      const viz =
        priorViz?.type === layer.viz.type ? priorViz : layer.viz;
      setAppearanceDraft(layerId, { ...prior, viz: { ...viz, fill } });
    },
    [authoritativeLayersRef, setAppearanceDraft],
  );

  const commitStyleAppearance = useStyleAppearanceCommit({
    sequence: mutations.sequence, authoritativeLayersRef, appearancePreviewVersionRef, clearAppearanceDraft, patchLayer,
  });

  // Cell height slides like any appearance channel (field fix): the
  // cells and their elevation values don't move when only the height does,
  // so the draft repaints the geojson the client already holds and the
  // commit persists without a render refetch.
  const previewAggregatedElevation = useCallback(
    (layerId: string, elevation: CellElevation) => {
      const layer = authoritativeLayersRef.current[layerId];
      if (!layer || !isAggregated(layer.viz)) return;
      appearancePreviewVersionRef.current[layerId] =
        (appearancePreviewVersionRef.current[layerId] ?? 0) + 1;
      const prior = appearanceDraftRef.current[layerId];
      const priorViz = prior?.viz;
      const viz = priorViz?.type === layer.viz.type ? priorViz : layer.viz;
      setAppearanceDraft(layerId, { ...prior, viz: { ...viz, elevation } });
    },
    [authoritativeLayersRef, setAppearanceDraft],
  );

  const commitAggregatedElevation = useCallback(
    (layerId: string, elevation: CellElevation): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const result = (async () => {
        const current = authoritativeLayersRef.current[layerId];
        if (!current || !isAggregated(current.viz)) {
          if (appearancePreviewVersionRef.current[layerId] === version) {
            clearAppearanceDraft(layerId);
          }
          return false;
        }
        const next = { ...current.viz, elevation };
        const unchanged =
          JSON.stringify(next) === JSON.stringify(current.viz);
        const updated = unchanged
          ? current
          : await patchLayer(layerId, (accepted) => ({ viz: { ...accepted.viz, elevation } }), {
              skipRefresh: true,
              separateHistoryStep: true,
            });
        if (mutations.sequence.stale) return false;
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      })();
      return result;
    },
    [authoritativeLayersRef, clearAppearanceDraft, patchLayer, mutations.sequence],
  );

  const commitAggregatedFill = useCallback(
    (layerId: string, fill: FillPaint): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const result = (async () => {
        const current = authoritativeLayersRef.current[layerId];
        if (!current || !isAggregated(current.viz)) {
          if (appearancePreviewVersionRef.current[layerId] === version) {
            clearAppearanceDraft(layerId);
          }
          return false;
        }
        const next = { ...current.viz, fill };
        const unchanged =
          JSON.stringify(next) === JSON.stringify(current.viz);
        const updated = unchanged
          ? current
          : await patchLayer(layerId, (accepted) => ({ viz: { ...accepted.viz, fill } }), {
              skipRefresh: true,
              separateHistoryStep: true,
            });
        if (mutations.sequence.stale) return false;
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      })();
      return result;
    },
    [authoritativeLayersRef, clearAppearanceDraft, patchLayer, mutations.sequence],
  );

  // Arc/line/cluster appearance previews: height, target color, and cluster
  // radius are appearance-only — they draft through the same channel as
  // style appearance, and commit without a render refetch.
  const previewVizAppearance = useCallback(
    (layerId: string, viz: OdViz | ClusterViz) => {
      const layer = authoritativeLayersRef.current[layerId];
      if (!layer || layer.viz.type !== viz.type) return;
      appearancePreviewVersionRef.current[layerId] =
        (appearancePreviewVersionRef.current[layerId] ?? 0) + 1;
      const prior = appearanceDraftRef.current[layerId];
      setAppearanceDraft(layerId, { ...prior, viz });
    },
    [authoritativeLayersRef, setAppearanceDraft],
  );

  const commitVizAppearance = useCallback(
    (layerId: string, viz: OdViz | ClusterViz): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const result = (async () => {
        const current = authoritativeLayersRef.current[layerId];
        if (!current || current.viz.type !== viz.type) {
          if (appearancePreviewVersionRef.current[layerId] === version) {
            clearAppearanceDraft(layerId);
          }
          return false;
        }
        const unchanged =
          JSON.stringify(viz) === JSON.stringify(current.viz);
        const updated = unchanged
          ? current
          : await patchLayer(layerId, { viz }, {
              skipRefresh: true,
              separateHistoryStep: true,
            });
        if (mutations.sequence.stale) return false;
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      })();
      return result;
    },
    [authoritativeLayersRef, clearAppearanceDraft, patchLayer, mutations.sequence],
  );

  // The widget editor's unsaved widget: the presentation overlays it on
  // the stored list so the rail previews every edit live, titles at once
  // and numbers through the same batched read, which carries the draft
  // for server-side computation. Nothing writes.
  const [widgetPreview, setWidgetPreview] = useState<MapWidget | null>(null);
  const widgetEndpoints = useMemo(
    () => mapWidgetEndpoints(mapId, widgetPreview),
    [mapId, widgetPreview],
  );
  // The style panel's heatmap previews drive the canvas's channel; the
  // presentation hands it to the live filters too.
  const onHeatmapPreviewSetter = useCallback((set: HeatmapPreviewSetter) => {
    heatmapPreviewSetterRef.current = set;
  }, []);
  // What a reader sees of the map (the layers as drawn, the legend, the
  // widgets with their values and selections, the live filters, the
  // camera and its fitting) lives in use-map-presentation.ts and draws
  // through MapPresentation; authoring's drafts arrive as its inputs.
  const presentation = useMapPresentation({
    map,
    renders,
    rendersRef,
    mapRef: serverMapRef,
    endpoints: widgetEndpoints,
    cameraRef: zoomHandleRef,
    setFitBounds,
    fail,
    clearFailure,
    statusPillHidden,
    fullscreen: mapFull,
    sliderDrafts: querySliderDrafts,
    appearanceDrafts,
    legendLive,
    widgetDraft: widgetPreview,
    widenDashboard: !!exportCard.seed,
    onHeatmapPreviewSetter,
  });
  const { live, fitLayer, onSearchAction, visibleWidgets } = presentation;
  // The docked timeline: orchestration lives beside MapBuilder, not in
  // it (use-timeline.ts). Its settle and speed persist, so it stays with
  // the author; the presentation draws the bar it is handed.
  const timeline = useTimeline({
    map,
    patchMap,
    patchLayer,
    refreshLayer,
    preview: live.preview,
  });
  // The status pill delays its entry while a timeline is docked (review
  // round two): restoring the pill would otherwise mount it under the
  // bar mid-glide back to its resting bottom.
  const timelineDocked = timeline.bar !== null;
  useEffect(() => {
    if (!timelineDocked) return;
    document.body.setAttribute("data-timeline-docked", "");
    return () => document.body.removeAttribute("data-timeline-docked");
  }, [timelineDocked]);
  const widgetList = useWidgetListActions({
    map,
    visibleWidgets,
    setMap,
    patchMap,
    truthSeqRef,
    mapFieldEditedAtRef,
    setTab,
    setWidgetFocus,
  });

  // Adding a time filter docks the timeline by itself (the widget is the
  // default experience, not an easter egg). Sequenced after the filter
  // write — the dock validates against stored state. The refetch runs
  // only when the edit changes what the server ships: live-filter edits
  // update the canvas straight from state.
  const timelineDock = timeline.dock;
  const editFilters = useCallback(
    (layer: Layer, filters: LayerFilter[]): Promise<boolean> => {
      const result = (async () => {
        const current = authoritativeLayersRef.current[layer.id] ?? layer;
        const had = new Set(
          current.filters
            .filter((f) => f.kind === "timerange")
            .map((f) => f.field),
        );
        const added = filters.find(
          (f) => f.kind === "timerange" && !had.has(f.field),
        );
        const updated = await patchLayer(layer.id, { filters }, {
          skipRefresh: !live.needsRefresh(current, filters),
          separateHistoryStep: true,
        });
        if (!updated) return false;
        if (added && !isAggregated(current.viz)) {
          timelineDock(layer.id, added.field);
        }
        return true;
      })();
      return result;
    },
    [authoritativeLayersRef, patchLayer, live, timelineDock],
  );

  // In-place label edit on the canvas legend: merge the one slot into the
  // layer's positional overrides and save through the same PATCH the rail
  // uses. Null returns the slot to its automatic label.
  const onLegendLabelEdit = useCallback(
    (layerId: string, slot: number, value: string | null) => {
      const layer = map?.layers.find((l) => l.id === layerId);
      if (!layer) return;
      const labels: (string | null)[] = layer.legendLabels
        ? [...layer.legendLabels]
        : [];
      while (labels.length <= slot) labels.push(null);
      labels[slot] = value;
      const next = labels.every((v) => v === null) ? null : labels;
      void patchLayer(layerId, { legendLabels: next });
    },
    [map, patchLayer],
  );
  const onLegendTextClick = useCallback((target: LegendTextTarget) => {
    setTab("legend");
    setLegendFocus({ ...target, nonce: Date.now() });
  }, []);

  // Draw on the map: the whole integration lives in
  // use-draw-integration; the builder carries wiring only. ----
  const draw = useDrawIntegration({
    mapId,
    request: mutations.request,
    reloadKey,
    reload,
    selectLayer: setSelectedId,
    refreshLayer,
    layers: map?.layers ?? [],
    announce: showNotice,
    offerPickedLayer,
  });

  const { duplicateLayer, reorderLayers, deleteLayer } = useBuilderLayerActions({
    mutations, draw, mapId, selectedId, setSelectedId, setMap, removeRender, refreshLayer,
  });

  if (failures.load && !map) {
    return (
      <BuilderLoadFailure
        message={failures.load}
        onRetry={() => {
          clearFailure("load");
          reload();
        }}
      />
    );
  }

  if (!map) return <BuilderLoading />;

  const effBasemap = builderBasemap(map, { theme, basemapUrl, basemapOverrideUrl, basemapOverrideAttribution, basemaps });
  const effectiveBasemapUrl = effBasemap.url;
  const effectiveBasemapKind = effBasemap.kind;
  const basemapCredit = effBasemap.attribution;


  return (
    <DocumentEditorContext.Provider value={mutations}>
    <BuilderSavedState value={{ stale: mutations.stale, saved: mutations.savedMap }}>
    <div className={styles.builder}>
      <HeaderChrome
        map={map}
        projectId={mapProjectId}
        history={history}
        onUndo={() => void applyHistory("undo")}
        onRedo={() => void applyHistory("redo")}
        onRename={(name) => void patchMap({ name })}
        assistant={helpers.door}
        onPublishChange={reload}
        onExportImage={exportCard.open}
        imageExportAvailable={exportCard.available}
        renders={renders}
        layerDataDownloads={layerDownloads.port}
      />
      <SearchControl mapId={mapId} map={map} onAction={onSearchAction} />

      <BuilderHelpers
        helpers={helpers}
        map={map}
        selectedLayerId={selectedId}
        onWorkspaceChange={reload}
        onLayerMade={setSelectedId}
        onMutate={reload}
        layerDataDownloads={layerDownloads.port}
      />

      <aside className={styles.rail} data-builder-pane>
          <Tabs
            group="builder"
            label="Builder panels"
            className={styles.tabs}
            fill
            value={tab}
            onChange={setTab}
            tabs={RAIL_TABS.map(item => item.value === "legend" ? { ...item, name: "Legend", label: <>Legend<LegendUnsavedDot map={map} live={legendLive} /></> } : item)}
          />

          <TabPanel group="builder" value={tab} className={styles.railContent}>
            <BuilderStaleNotice mutations={mutations} onRecovered={onRecovered} />
            <BuilderFailureNotes
              failures={mutations.stale ? {} : failures}
              clearFailure={clearFailure}
              activeDownloads={layerDownloads.activeDownloads}
              downloadFailures={layerDownloads.failures}
            />

            {tab === "layers" && (
              <>
                <LayerList
                  layers={map.layers}
                  renders={renders}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onToggle={(id, visible) => void patchLayer(id, { visible })}
                  onDelete={(id) => void deleteLayer(id)}
                  sketchByLayer={draw.cardLines}
                  onDuplicate={(id) => void duplicateLayer(id)}
                  onRename={(id, name) => void patchLayer(id, { name })}
                  onFit={fitLayer}
                  onEditSource={(id) => {
                    const layer = map.layers.find((l) => l.id === id);
                    if (layer) openCatalogEdit(layer);
                  }}
                  onReorder={reorderLayers}
                  layerDataDownloads={layerDownloads.port}
                  stylePanel={(layer) => (
                    <StylePanel
                      key={layer.id}
                      layer={layer}
                      render={renders[layer.id]}
                      labelCount={labelCounts[layer.id] ?? null}
                      pitch={presentation.pitch}
                      onPitch={(deg) =>
                        zoomHandleRef.current?.setPitch(deg, false)
                      }
                      onStyle={(style) => void patchLayer(layer.id, { style })}
                      onStylePreview={(partial) =>
                        previewStyleAppearance(layer.id, partial)
                      }
                      onStyleCommit={(partial) =>
                        commitStyleAppearance(layer.id, partial)
                      }
                      onTooltip={(tooltip) =>
                        void patchLayer(layer.id, { tooltip })
                      }
                      onPopup={(popup) => void patchLayer(layer.id, { popup })}
                      onViz={(viz) =>
                        // Appearance-only viz ticks (heatmap radius/
                        // intensity/weight) redraw from data the client
                        // holds — no refetch.
                        void patchLayer(layer.id, { viz }, {
                          skipRefresh: vizAppearanceOnly(layer.viz, viz),
                        })
                      }
                      onVizPreview={(viz, field) =>
                        previewHeatmapViz(layer.id, viz, field)
                      }
                      onVizCommit={(viz, field) =>
                        commitHeatmapViz(layer.id, viz, field)
                      }
                      onAggregationPreview={(viz) =>
                        previewAggregationViz(layer, viz)
                      }
                      onAggregationCommit={(viz) =>
                        commitAggregationViz(layer.id, viz)
                      }
                      onAggregatedFillPreview={(fill) =>
                        previewAggregatedFill(layer.id, fill)
                      }
                      onAggregatedFillCommit={(fill) =>
                        commitAggregatedFill(layer.id, fill)
                      }
                      onElevationPreview={(elevation) =>
                        previewAggregatedElevation(layer.id, elevation)
                      }
                      onElevationCommit={(elevation) =>
                        commitAggregatedElevation(layer.id, elevation)
                      }
                      onOdPreview={(viz) => previewVizAppearance(layer.id, viz)}
                      onOdCommit={(viz) => commitVizAppearance(layer.id, viz)}
                      onQueryPreviewStart={() =>
                        void prepareQuerySliderPreview(layer)
                      }
                      onFilters={(filters) => editFilters(layer, filters)}
                      onFilterPreview={(filters) =>
                        runQuerySliderPreview(layer, layer.viz, filters)
                      }
                      onFilterPreviewEnd={(accepted) =>
                        accepted
                          ? settleQuerySliderPreview(layer.id)
                          : endQuerySliderPreview(layer.id)
                      }
                      timeline={map.timeline}
                      onDock={(field) => timeline.dock(layer.id, field)}
                      onUndock={timeline.undock}
                      liveFields={live.liveFields(layer.id)}
                      onLivePreview={(field, range) =>
                        live.preview(layer.id, field, range)
                      }
                      onLivePreviewStart={() => live.begin(layer.id)}
                      onLivePreviewEnd={(accepted) =>
                        live.end(layer.id, accepted)
                      }
                    />
                  )}
                />
                <AddLayerTrigger onOpen={openCatalogAdd} />
              </>
            )}

            {tab === "basemap" && (
              <BasemapTab
                map={map}
                loadedGroups={loadedBasemapGroups}
                overridden={basemapOverrideUrl !== null}
                basemaps={basemaps}
                patchMap={patchMap}
                statusPillVisible={!statusPillHidden}
                onToggleStatusPill={(visible) => statusPillStore.write(!visible)}
              />
            )}

            {tab === "widgets" && (
              <WidgetsTab
                map={map}
                focus={widgetFocus}
                onChange={widgetList.apply}
                onPreview={setWidgetPreview}
                onPublishedToggle={(on) =>
                  void patchMap({ widgetsPublished: on })
                }
              />
            )}

            {tab === "legend" && (
              <LegendTab
                layers={map.layers}
                corner={map.legendCorner}
                legendOrder={map.legendOrder}
                focus={legendFocus}
                onLive={onLegendLive}
                {...legendTab}
              />
            )}
          </TabPanel>
        </aside>

      {/* The map as a reader would see it, drawn by MapPresentation;
          the author's furniture enters through its slots: the preview
          badge first over the map, the stage controls before the credit. */}
      <MapPresentation
        stage={presentation}
        map={map}
        basemap={effBasemap}
        theme={theme}
        stageEdges={stageEdges}
        fitBounds={fitBounds}
        timeline={timeline.bar}
        audience="author"
        windowRef={mapLayerRef}
        overlay={
          querySliderApproximate && (
            <div className={styles.previewBadge}>Approximate preview</div>
          )
        }
        legend={{
          dragPreview,
          onPreview: setDragPreview,
          onDrop: (legendCorner) => void patchMap({ legendCorner }),
          onTextClick: onLegendTextClick,
          onLabelEdit: onLegendLabelEdit,
        }}
        widgetActions={{
          onOptions: widgetList.openOptions,
          onDelete: widgetList.remove,
          onReorder: widgetList.reorderVisible,
        }}
        canvas={{
          onFeaturePick: draw.onCanvasFeaturePick,
          onViewportChange: persistViewport,
          onLabelCounts,
          onBasemapGroups: setLoadedBasemapGroups,
          onSnapshotHandle,
          onCameraHandle: setDrawCamera,
        }}
        controls={
          <BuilderStageControls
            cameraRef={zoomHandleRef}
            bearing={presentation.bearing}
            pitch={presentation.pitch}
            onFitAll={presentation.fitAll}
            mapFull={mapFull}
            onMapFull={setMapFull}
            draw={draw}
            drawCamera={drawCamera}
            saving={!mutations.stale && pendingSaves > 0}
            notice={importNotice}
          />
        }
      />

      {exportCard.seed && (
        <ExportImageCard
          stage={buildExportStage({
            map,
            appearance: theme,
            layers: presentation.stagedLayers,
            basemapUrl: effectiveBasemapUrl,
            basemapKind: effectiveBasemapKind,
            fallbackColor: BASEMAP_FALLBACKS[theme],
            liveFilters: presentation.canvasDims,
            seed: exportCard.seed,
            legendLayers: presentation.legendLayers,
            widgets: presentation.resolvableWidgets,
            values: presentation.dash.values,
            valuesState: presentation.dash.valuesState,
            selections: presentation.dash.selections,
            attribution: basemapCredit,
          })}
          onClose={exportCard.close}
        />
      )}

      <CatalogHost
        sources={layerSources}
        failures={failures}
        map={map}
        projectId={mapProjectId}
      />

    </div>
    </BuilderSavedState>
    </DocumentEditorContext.Provider>
  );
}

export const MapBuilder = withBuilderRecovery(BuilderEditor);

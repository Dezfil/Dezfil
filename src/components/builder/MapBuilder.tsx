"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import dynamic from "next/dynamic";
import type {
  MapWithLayers,
  Layer,
  Viewport,
} from "@/lib/metadata/maps";
import type { HistoryAvailability } from "@/lib/metadata/history";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import {
  effectiveStyle,
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
import { readApiError, readApiFailure } from "../api";
import {
  NETWORK_FAILURE,
  type EndpointResult,
} from "../widgets/dashboard-state";
import type { Bounds } from "@/lib/geo-bounds";
import type {
  HeatmapPreviewSetter,
  RenderedLayer,
} from "../map/MapCanvas";
import type { CameraHandle } from "../map/camera-handle";
import { createStatusChannel } from "@/lib/map-status";
import {
  mergeHeatmapControl,
  type HeatmapControlField,
} from "@/lib/heatmap-quality";
import { BuilderStageControls } from "./BuilderStageControls";
import { drawState, setDrawSelection } from "./draw/draw-mode";
import { useDrawIntegration } from "./draw/use-draw-integration";
import { usePublishedThemeSync } from "./use-published-theme-sync";
import { useCameraState } from "./use-camera-state";
import { SearchControl } from "./search/SearchControl";
import { BuilderLoadFailure, BuilderLoading } from "./BuilderFallback";
import { TabPanel, Tabs } from "../ui/Tabs";
import { StatusBar } from "./StatusBar";
import { useLegendLayers } from "./use-legend-layers";
import { useLegendTab } from "./use-legend-tab";
import { offerLayer } from "./drawer/pick-mode";
import {
  type AppearanceDraft,
  statusPillStore,
  RAIL_TABS,
  type RailTab,
} from "./builder-shell-state";
import {
  fetchLayerRender,
  renderBounds,
  type LayerRenderData,
} from "./render-data";
import { useLayerSourceCoordinator } from "./use-layer-source-coordinator";
import { AddLayerTrigger } from "./add-layer/AddLayerCatalog";
import { CatalogHost } from "./add-layer/CatalogHost";
import { HeaderChrome } from "./BuilderChrome";
import { BuilderHelpers, useBuilderHelpers } from "./BuilderHelpers";
import { ExportImageCard } from "./export/ExportImageCard";
import { buildExportStage } from "./export/export-stage";
import { useExportCard } from "./export/use-export-card";
import { useThumbnailCapture } from "./use-thumbnail-capture";
import { useBuilderWidgets } from "./use-builder-widgets";
import { useWidgetListActions } from "./use-widget-list-actions";
import { LayerList } from "./LayerList";
import { StylePanel } from "./StylePanel";
import { BasemapTab } from "./BasemapTab";
import { useLabelCounts } from "./use-label-counts";
import {
  LegendTab,
  type LegendFocus,
  type LegendLiveText,
} from "./LegendTab";
import { CornerDrag } from "./CornerDrag";
import { LegendPanel, type LegendTextTarget } from "../map/LegendPanel";
import { BuilderLegendCorners } from "./BuilderLegendCorners";
import { TimelineBar } from "../map/TimelineBar";
import { useLiftClearance } from "../map/use-lift-clearance";
import { useLegendPlacement } from "../map/use-legend-placement";
import { useTimeline } from "./use-timeline";
import { useLiveFilters } from "./use-live-filters";
import { WidgetsTab, type WidgetFocus } from "./WidgetsTab";
import { WidgetRail } from "../widgets/WidgetRail";
import { SettleStatus } from "../widgets/SettleStatus";
import widgetStyles from "../widgets/Widgets.module.css";
import {
  useWidgetDashboard,
  type DashboardLayer,
} from "../widgets/use-widget-dashboard";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";
import type { WidgetValues } from "@/lib/widget-service";
import {
  liveFilters as liveFilterRule,
  LIVE_FILTER_SLOTS,
  type LiveDim,
} from "@/lib/live-filters";
import { useQuerySliderPreview } from "./use-query-slider-preview";
import { useMutationLane } from "./use-mutation-lane";
import { useMapHistory } from "./use-map-history";
import { useLayerDataDownloads } from "./use-layer-data-downloads";
import { BuilderFailureNotes } from "./BuilderFailureNotes";
import styles from "./MapBuilder.module.css";

const MapCanvas = dynamic(
  () => import("../map/MapCanvas").then((m) => m.MapCanvas),
  { ssr: false, loading: () => <div className={styles.canvasLoading} /> },
);


export function MapBuilder({
  mapId,
  initialLayerId = null,
  basemapUrl,
  basemapOverrideUrl = null,
  basemapOverrideAttribution = [],
  basemaps = BASEMAPS,
}: {
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
  const [renders, setRenders] = useState<Record<string, LayerRenderData>>({});
  const rendersRef = useRef<Record<string, LayerRenderData>>({});
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
  const [reloadKey, setReloadKey] = useState(0);
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
  // Compass needle (integer degrees); right-drag rotation moves it, the
  // button eases the view back flat and north-up.
  const [mapBearing, setMapBearing] = useState(0);
  // Camera tilt (integer degrees) — drives the tilt toggle's state and the
  // fine pitch slider.
  const [mapPitch, setMapPitch] = useState(0);
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
  // Undo/redo availability: seeded by the history read, then derived —
  // any successful edit enables undo and clears redo; undo/redo responses
  // carry the authoritative values.
  const [history, setHistory] = useState<HistoryAvailability>({
    canUndo: false,
    canRedo: false,
  });
  const edited = useCallback(
    () => setHistory({ canUndo: true, canRedo: false }),
    [],
  );
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
  const authoritativeLayersRef = useRef<Record<string, Layer>>({});
  // Response application is newest-wins per object. A map response
  // embeds the whole layer set as it stood when the server read it, so
  // applying one wholesale can revert a layer its own lane has since
  // confirmed — and then poison the authoritative ref the next commit
  // diffs against. Every confirmation takes a ticket from this counter;
  // a response only speaks for layers nobody confirmed after it was
  // sent.
  const truthSeqRef = useRef(0);
  const layerConfirmedAtRef = useRef<Record<string, number>>({});
  // Structural changes take tickets too: a duplicate's copy must not be
  // removed, and a deletion must not be undone, by a map response sent
  // before they were confirmed.
  const layerRemovedAtRef = useRef<Record<string, number>>({});
  // Optimistic map-field edits (widgets, layer order) take tickets so an
  // earlier response's echo cannot regress them while their own write is
  // still queued — a further edit built from the regressed state would
  // durably drop the queued one.
  const mapFieldEditedAtRef = useRef<
    Partial<Record<"widgets" | "layerOrder" | "legendOrder", number>>
  >({});
  /** The counter's value when the current map state was produced. */
  const mapAppliedAtRef = useRef(0);
  // The last server-confirmed map body: what queued patch bodies merge
  // against when their turn starts, and what the builder falls back to
  // when even the reconciliation read fails — optimistic state must not
  // stand indefinitely as if accepted.
  const serverMapRef = useRef<MapWithLayers | null>(null);
  // Bumped by every whole-map resync (load, applied history step). A save
  // whose request predates the bump may not apply its echo — the resync
  // already holds newer truth, and a stale echo would revert it (two
  // writers converge).
  const reloadEpochRef = useRef(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const refreshLayer = useCallback(async (layerId: string) => {
    const data = await fetchLayerRender(layerId);
    rendersRef.current = { ...rendersRef.current, [layerId]: data };
    setRenders((r) => ({ ...r, [layerId]: data }));
  }, []);

  // In-progress Legend-tab text, mirrored to the canvas legend on every
  // keystroke; a layer's entry clears when its save echoes back, at which
  // point persisted and live text agree anyway.
  const [legendLive, setLegendLive] = useState<Record<string, LegendLiveText>>(
    {},
  );
  const onLegendLive = useCallback((id: string, text: LegendLiveText) => {
    setLegendLive((prev) => ({ ...prev, [id]: { ...prev[id], ...text } }));
  }, []);
  // A recovered read is authoritative for live text too: the lane
  // discards an entry that was waiting for a lost response rather than
  // leaving it over stale state.
  const clearLegendLive = useCallback((layerId: string) => {
    setLegendLive((prev) => {
      if (!(layerId in prev)) return prev;
      const next = { ...prev };
      delete next[layerId];
      return next;
    });
  }, []);

  // The mutation/recovery lane: the ordered write lanes with
  // verify-then-reconcile recovery, newest-wins response application,
  // lane-owned failure banners, and pending-saves accounting — extracted
  // beside MapBuilder (use-mutation-lane.ts), sharing the truth refs above.
  const {
    failures,
    fail,
    clearFailure,
    pendingSaves,
    track,
    applyMapResponse,
    patchMap,
    patchLayer,
  } = useMutationLane({
    mapId,
    map,
    setMap,
    rendersRef,
    authoritativeLayersRef,
    truthSeqRef,
    layerConfirmedAtRef,
    layerRemovedAtRef,
    mapFieldEditedAtRef,
    mapAppliedAtRef,
    serverMapRef,
    reloadEpochRef,
    refreshLayer,
    reload,
    edited,
    clearLegendLive,
  });

  const layerDownloads = useLayerDataDownloads(mapId, map?.layers ?? []);

  // A published map follows the mode its author composes in.
  usePublishedThemeSync({
    mapId,
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
  const heatmapCommitQueueRef = useRef<Record<string, Promise<void>>>({});
  const aggregationPreviewVersionRef = useRef<Record<string, number>>({});
  const aggregationCommitQueueRef = useRef<Record<string, Promise<void>>>({});
  const filterCommitQueueRef = useRef<Record<string, Promise<void>>>({});
  const [appearanceDrafts, setAppearanceDrafts] = useState<
    Record<string, AppearanceDraft>
  >({});
  const appearanceDraftRef = useRef<Record<string, AppearanceDraft>>({});
  const appearancePreviewVersionRef = useRef<Record<string, number>>({});
  const appearanceCommitQueueRef = useRef<Record<string, Promise<void>>>({});
  // Live canvas → status bar stream; only the bar re-renders.
  const [statusChannel] = useState(createStatusChannel);
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
    [endQuerySliderPreview, reconcileQuerySliderPreview],
  );

  // Load the map and every layer's render data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Authority demands fresh truth: if a write confirms while the
        // read is on the wire, the body may predate it — re-read rather
        // than install a snapshot that would regress the accepted edit.
        // Contention is transient; the cap only guards a pathological
        // edit storm.
        let body!: MapWithLayers;
        for (let attempt = 0; attempt < 3; attempt++) {
          const seqAtStart = truthSeqRef.current;
          const response = await fetch(`/api/maps/${mapId}`);
          if (!response.ok) throw new Error(await readApiError(response));
          body = (await response.json()) as MapWithLayers & {
            projectId?: string | null;
          };
          if (cancelled) return;
          if (truthSeqRef.current === seqAtStart) break;
        }
        authoritativeLayersRef.current = Object.fromEntries(
          body.layers.map((layer) => [layer.id, layer]),
        );
        // A load is authoritative for the whole map: it supersedes every
        // lane confirmation, so a late response cannot drag it back
        // (this is also the assistant's resync path).
        layerConfirmedAtRef.current = {};
        layerRemovedAtRef.current = {};
        mapFieldEditedAtRef.current = {};
        truthSeqRef.current += 1;
        reloadEpochRef.current += 1;
        mapAppliedAtRef.current = truthSeqRef.current;
        serverMapRef.current = body;
        setMap(body);
        setMapProjectId(
          (body as { projectId?: string | null }).projectId ?? null,
        );
        // A recovered reload clears the load lane's standing failure —
        // its banner must not outlive the condition.
        clearFailure("load");
        // Seed the undo/redo buttons; also re-runs after assistant turns.
        void fetch(`/api/maps/${mapId}/history`).then(async (r) => {
          if (r.ok && !cancelled) {
            setHistory((await r.json()) as HistoryAvailability);
          }
        });
        const entries = await Promise.all(
          body.layers.map(
            async (l) => [l.id, await fetchLayerRender(l.id)] as const,
          ),
        );
        if (cancelled) return;
        const nextRenders = Object.fromEntries(entries);
        rendersRef.current = nextRenders;
        setRenders(nextRenders);
        // Frame the data once it has loaded (spec: fit-to-bounds on the data
        // extent). Done here in the load handler, not a reactive effect.
        // During an import's focus window the camera belongs to the newly
        // added layers — no global reframe.
        if (!importFocusRef.current.active) {
          const b = renderBounds(entries.map(([, r]) => r));
          if (b) setFitBounds([...b] as Bounds);
        }
      } catch (e) {
        if (!cancelled)
          fail("load", e instanceof Error ? e.message : "Failed to load map");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mapId, reloadKey, clearFailure, fail, importFocusRef]);

  // Tiles prepare in the background: poll a preparing layer's render
  // until it settles into ready (drawn) or failed (errored state).
  useEffect(() => {
    const preparing = Object.values(renders)
      .filter((r) => r.ok && r.tiles?.state === "building")
      .map((r) => r.layerId);
    if (preparing.length === 0) return;
    const timer = setTimeout(() => {
      for (const id of preparing) void refreshLayer(id);
    }, 2500);
    return () => clearTimeout(timer);
  }, [renders, refreshLayer]);

  const renderedLayers: RenderedLayer[] = useMemo(() => {
    if (!map) return [];
    return map.layers.map((l) => {
      const r = renders[l.id];
      const preview = querySliderDrafts[l.id];
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
  }, [map, renders, querySliderDrafts, appearanceDrafts]);

  // The legend inputs live in their own module (the at-touch
  // decomposition slice), carrying rendered geometry for the swatch rule.
  const legendLayers = useLegendLayers({
    map,
    renders,
    legendLive,
    appearanceDrafts,
  });

  // The Legend tab's write wiring lives in use-legend-tab since 0119.
  const legendTab = useLegendTab({
    patchMap,
    patchLayer,
    setMap,
    truthSeqRef,
    mapFieldEditedAtRef,
  });

  // The camera keeps its own lane, outside the ordered map queue: it is
  // latest-wins by nature — the newest position is the truth whatever the
  // arrival order — and persisting it must never delay or reorder a real
  // edit. Its response is deliberately never read, so it cannot regress
  // anything. A failed write is the one permitted silent drop: nothing
  // surfaces, and the next movement persists normally. Single-flight
  // makes latest-wins real on the server too: at most one camera write is
  // in the air, and a burst coalesces to the newest position — so arrival
  // order can never settle an older viewport.
  const cameraFlightRef = useRef(false);
  const cameraPendingRef = useRef<Viewport | null>(null);
  const persistViewport = useCallback(
    (v: Viewport) => {
      viewportRef.current = v;
      if (cameraFlightRef.current) {
        // Coalesce, never queue: only the newest position matters.
        cameraPendingRef.current = v;
        return;
      }
      const send = (position: Viewport) => {
        cameraFlightRef.current = true;
        void track(
          fetch(`/api/maps/${mapId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ viewport: position }),
          }),
        )
          .catch(() => {
            // Silent by design — the camera is unrecorded in history and
            // the next gesture repairs it. Handled so it is never an
            // unhandled rejection.
          })
          .finally(() => {
            cameraFlightRef.current = false;
            const pending = cameraPendingRef.current;
            cameraPendingRef.current = null;
            if (pending) send(pending);
          });
      };
      send(v);
    },
    [mapId, track],
  );

  // Snapshot capture: wiring lives in its own hook (the at-touch slice
  // for the capture surface).
  const onSnapshotHandle = useThumbnailCapture(mapId, map, renders, { theme, basemapUrl, basemapOverrideUrl, basemaps });

  // Undo/redo is its own serialized lane, with a generation fence so a
  // superseded repaint never lands.

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
    [],
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
      const before = heatmapCommitQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
        const currentLayer = authoritativeLayersRef.current[layerId];
        const current = currentLayer?.viz;
        const nextViz =
          current?.type === "heatmap"
            ? mergeHeatmapControl(current, viz, field)
            : viz;
        const updated =
          current?.type === "heatmap" && current[field] === nextViz[field]
            ? currentLayer
            : await patchLayer(layerId, { viz: nextViz }, {
                skipRefresh: true,
                separateHistoryStep: true,
              });
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
      });
      heatmapCommitQueueRef.current[layerId] = result.then(() => undefined);
      return result;
    },
    [patchLayer],
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
      const before =
        aggregationCommitQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
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
        if (aggregationPreviewVersionRef.current[layerId] === version) {
          if (updated && !unchanged) settleQuerySliderPreview(layerId);
          else endQuerySliderPreview(layerId);
        }
        return updated !== null;
      });
      aggregationCommitQueueRef.current[layerId] = result.then(() => undefined);
      return result;
    },
    [endQuerySliderPreview, patchLayer, settleQuerySliderPreview],
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
      const prior = appearanceDraftRef.current[layerId];
      setAppearanceDraft(layerId, {
        ...prior,
        style: { ...(prior?.style ?? layer.style), ...partial },
      });
    },
    [setAppearanceDraft],
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
    [setAppearanceDraft],
  );

  const commitStyleAppearance = useCallback(
    (layerId: string, partial: Partial<LayerStyle>): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const before =
        appearanceCommitQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
        const current = authoritativeLayersRef.current[layerId];
        if (!current) {
          if (appearancePreviewVersionRef.current[layerId] === version) {
            clearAppearanceDraft(layerId);
          }
          return false;
        }
        const next = { ...current.style, ...partial };
        const unchanged = JSON.stringify(next) === JSON.stringify(current.style);
        const updated = unchanged
          ? current
          : await patchLayer(
              layerId,
              { style: next },
              { separateHistoryStep: true },
            );
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      });
      appearanceCommitQueueRef.current[layerId] = result.then(() => undefined);
      return result;
    },
    [clearAppearanceDraft, patchLayer],
  );

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
    [setAppearanceDraft],
  );

  const commitAggregatedElevation = useCallback(
    (layerId: string, elevation: CellElevation): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const before =
        appearanceCommitQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
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
          : await patchLayer(layerId, { viz: next }, {
              skipRefresh: true,
              separateHistoryStep: true,
            });
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      });
      appearanceCommitQueueRef.current[layerId] = result.then(() => undefined);
      return result;
    },
    [clearAppearanceDraft, patchLayer],
  );

  const commitAggregatedFill = useCallback(
    (layerId: string, fill: FillPaint): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const before =
        appearanceCommitQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
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
          : await patchLayer(layerId, { viz: next }, {
              skipRefresh: true,
              separateHistoryStep: true,
            });
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      });
      appearanceCommitQueueRef.current[layerId] = result.then(() => undefined);
      return result;
    },
    [clearAppearanceDraft, patchLayer],
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
    [setAppearanceDraft],
  );

  const commitVizAppearance = useCallback(
    (layerId: string, viz: OdViz | ClusterViz): Promise<boolean> => {
      const version = appearancePreviewVersionRef.current[layerId] ?? 0;
      const before =
        appearanceCommitQueueRef.current[layerId] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
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
        if (appearancePreviewVersionRef.current[layerId] === version) {
          clearAppearanceDraft(layerId);
        }
        return updated !== null;
      });
      appearanceCommitQueueRef.current[layerId] = result.then(() => undefined);
      return result;
    },
    [clearAppearanceDraft, patchLayer],
  );

  // Live filters and the docked timeline: orchestration lives beside
  // MapBuilder, not in it — see use-live-filters.ts and
  // use-timeline.ts.
  const live = useLiveFilters({ map, renders });
  const registerLiveHeatmapPreview = live.onHeatmapPreviewSetter;
  const registerHeatmapPreview = useCallback(
    (set: HeatmapPreviewSetter) => {
      heatmapPreviewSetterRef.current = set;
      registerLiveHeatmapPreview(set);
    },
    [registerLiveHeatmapPreview],
  );
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

  // Widgets & cross-filtering: the dashboard hook owns selection state
  // and fans enforcement out — GPU dimensions for layers that draw
  // features, settle re-renders for computed results. Value reads are
  // batched and never tracked as saves (they are reads). The open widget
  // editor's unsaved state: it overlays the stored list so the rail
  // previews every edit live — titles instantly, numbers through the
  // same batched read, which carries the draft for server-side
  // computation. Nothing writes.
  const [widgetPreview, setWidgetPreview] = useState<MapWidget | null>(null);
  const widgetEndpoints = useMemo(
    () => ({
      values: async (
        selections: WidgetSelection[],
      ): Promise<EndpointResult<WidgetValues>> => {
        try {
          const r = await fetch(`/api/maps/${mapId}/widget-values`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              selections,
              ...(widgetPreview ? { draft: widgetPreview } : null),
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
    }),
    [mapId, widgetPreview],
  );
  const { resolvableWidgets, visibleWidgets } = useBuilderWidgets(
    map,
    widgetPreview,
  );
  const railVisible = visibleWidgets.length > 0;
  const legendCornerEff = map?.legendCorner ?? "bottom-left";
  const legendPlacement = useLegendPlacement(
    legendCornerEff,
    railVisible,
    widgetStackEl,
    legendCandidateEl,
    `${cornerLift}:${creditLift && statusPillHidden}:${mapFull}`,
  );
  const legendDocked = legendPlacement.docked;
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
    // exports) real values, not an empty card. The builder rail keeps
    // rendering only the visible set.
    widgets: exportCard.seed ? resolvableWidgets : visibleWidgets,
    layers: dashboardLayers,
    endpoints: widgetEndpoints,
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
  // Fitting — beside MapBuilder, per the decomposition rule. It measures
  // what is drawn, defers a constrained tiled layer to the server, and
  // ignores an answer its constraints have outrun; it sits here because
  // it reads what the canvas is drawing, settled above.
  const { fitAll, fitLayer, flyTo, searchMarker, dismissSearchMarker,
    onSearchAction } = useCameraState({
    rendersRef, serverMapRef, dims: canvasDims, staged: dash.settleRenders,
    cameraRef: zoomHandleRef, setFitBounds, fail, clearFailure,
  });

  const widgetRecords = useMemo(() => {
    const rows = dash.values?.layers ?? [];
    if (rows.length === 0) return null;
    return {
      count: rows.reduce((s, r) => s + r.count, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
    };
  }, [dash.values]);

  // Adding a time filter docks the timeline by itself (the widget is the
  // default experience, not an easter egg). Sequenced after the filter
  // write — the dock validates against stored state. The refetch runs
  // only when the edit changes what the server ships: live-filter edits
  // update the canvas straight from state.
  const timelineDock = timeline.dock;
  const editFilters = useCallback(
    (layer: Layer, filters: LayerFilter[]): Promise<boolean> => {
      const before = filterCommitQueueRef.current[layer.id] ?? Promise.resolve();
      const result = before.catch(() => undefined).then(async () => {
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
      });
      filterCommitQueueRef.current[layer.id] = result.then(() => undefined);
      return result;
    },
    [patchLayer, timelineDock, live],
  );

  // Undo/redo — extracted to use-map-history.ts at the touch; the queue,
  // the generation fence and the keyboard binding live there unchanged.
  const { applyHistory } = useMapHistory({
    mapId,
    track,
    applyMapResponse,
    reload,
    fail,
    clearFailure,
    setHistory,
    setSelectedId,
    rendersRef,
    setRenders,
  });

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

  const duplicateLayer = useCallback(
    async (layerId: string) => {
      // Structural changes reconcile by reload: after a network-level
      // failure the copy may or may not exist — show the truth beside the
      // banner rather than guessing.
      const unconfirmed = (cause: unknown) => {
        fail(
          `layer:${layerId}`,
          `The layer duplication could not be confirmed. ${
            cause instanceof Error ? cause.message : "Network failure."
          }`,
        );
        reload();
      };
      let response: Response;
      try {
        response = await track(
          fetch(`/api/layers/${layerId}/duplicate`, { method: "POST" }),
        );
      } catch (cause) {
        unconfirmed(cause);
        return;
      }
      if (!response.ok) {
        fail(`layer:${layerId}`, await readApiError(response));
        return;
      }
      let copy: Layer;
      try {
        copy = (await response.json()) as Layer;
      } catch (cause) {
        unconfirmed(cause);
        return;
      }
      clearFailure(`layer:${layerId}`);
      // The copy takes a ticket: a map response sent before this
      // confirmation embeds a layer set without it, and must not remove
      // it on arrival.
      authoritativeLayersRef.current[copy.id] = copy;
      truthSeqRef.current += 1;
      layerConfirmedAtRef.current[copy.id] = truthSeqRef.current;
      serverMapRef.current = serverMapRef.current
        ? {
            ...serverMapRef.current,
            layers: [...serverMapRef.current.layers, copy],
          }
        : serverMapRef.current;
      setMap((m) => (m ? { ...m, layers: [...m.layers, copy] } : m));
      setSelectedId(copy.id);
      edited();
      await refreshLayer(copy.id);
    },
    [refreshLayer, track, edited, reload, clearFailure, fail],
  );

  const reorderLayers = useCallback(
    (bottomUpIds: string[]) => {
      // The optimistic order takes a ticket: an earlier response's echo
      // must not regress it while its write is queued.
      truthSeqRef.current += 1;
      mapFieldEditedAtRef.current.layerOrder = truthSeqRef.current;
      // Apply the order locally first: the drop animation needs the list in
      // its final order this frame, not after the server round-trip.
      setMap((m) => {
        if (!m) return m;
        const byId = new Map(m.layers.map((l) => [l.id, l]));
        const layers = bottomUpIds.flatMap((id) => byId.get(id) ?? []);
        return layers.length === m.layers.length ? { ...m, layers } : m;
      });
      void patchMap({ layerOrder: bottomUpIds });
    },
    [patchMap],
  );

  // Draw on the map: the whole integration lives in
  // use-draw-integration; the builder carries wiring only. ----
  const draw = useDrawIntegration({
    mapId,
    reloadKey,
    reload,
    selectLayer: setSelectedId,
    refreshLayer,
    layers: map?.layers ?? [],
    announce: showNotice,
    offerPickedLayer,
  });

  const deleteLayer = useCallback(
    async (layerId: string) => {
      // the provenance-named owner cascades to its dataset through the
      // sketch route; every other layer keeps the ordinary delete.
      const sketchTable = draw.sketchTableFor(layerId);
      let response: Response;
      try {
        response = await track(
          fetch(
            sketchTable
              ? `/api/sketches/${sketchTable}`
              : `/api/layers/${layerId}`,
            { method: "DELETE" },
          ),
        );
      } catch (cause) {
        // The delete may or may not have applied — reload shows the truth
        // beside the banner.
        fail(
          `layer:${layerId}`,
          `The layer deletion could not be confirmed. ${
            cause instanceof Error ? cause.message : "Network failure."
          }`,
        );
        reload();
        return;
      }
      if (!response.ok) {
        fail(`layer:${layerId}`, await readApiError(response));
        return;
      }
      clearFailure(`layer:${layerId}`);
      if (selectedId === layerId) setSelectedId(null);
      // The removal takes a ticket: a map response sent before this
      // confirmation still embeds the layer, and must not resurrect it
      // on arrival. The server cascaded bound widgets away in the same
      // undoable step — mirror that here, with the widgets ticket, so a
      // whole-array widget write can never re-introduce them.
      truthSeqRef.current += 1;
      layerRemovedAtRef.current[layerId] = truthSeqRef.current;
      mapFieldEditedAtRef.current.widgets = truthSeqRef.current;
      delete layerConfirmedAtRef.current[layerId];
      delete authoritativeLayersRef.current[layerId];
      serverMapRef.current = serverMapRef.current
        ? {
            ...serverMapRef.current,
            layers: serverMapRef.current.layers.filter(
              (l) => l.id !== layerId,
            ),
            widgets: serverMapRef.current.widgets.filter(
              (w) => w.layerId !== layerId,
            ),
          }
        : serverMapRef.current;
      setMap((m) =>
        m
          ? {
              ...m,
              layers: m.layers.filter((l) => l.id !== layerId),
              widgets: m.widgets.filter((w) => w.layerId !== layerId),
            }
          : m,
      );
      setRenders((r) => {
        const next = { ...r };
        delete next[layerId];
        rendersRef.current = next;
        return next;
      });
      if (sketchTable) {
        if (drawState().selected?.layerId === layerId) setDrawSelection(null);
        void draw.reloadSketches();
        // The cascade writes no history step:
        // edited()'s optimistic canUndo would expose a fake Undo, so the
        // buttons resync from the server instead.
        try {
          const r = await fetch(`/api/maps/${mapId}/history`);
          if (r.ok) setHistory((await r.json()) as HistoryAvailability);
        } catch {
          // Best-effort; the next edit or reload resyncs.
        }
        return;
      }
      edited();
    },
    [selectedId, track, edited, reload, clearFailure, fail, draw, mapId],
  );

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
            tabs={RAIL_TABS}
          />

          <TabPanel group="builder" value={tab} className={styles.railContent}>
            <BuilderFailureNotes
              failures={failures}
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
                      pitch={mapPitch}
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

        {/* The map itself: rendered full-viewport at all times and
            clipped to the card's window, so fullscreen and the dock
            animate the clip — never the canvas size — and no tile
            re-layout can shake the view. The card insets ride along as
            persistent view padding; fullscreen keeps them on purpose, so
            entering it moves not a single map pixel. */}
        <div className={styles.mapLayer} data-map-layer data-stage-edge={`${stageEdges.left}:${stageEdges.right}`}>
          <MapCanvas
            basemapUrl={effectiveBasemapUrl}
            basemapLayers={map.basemapLayers}
            basemapKind={effectiveBasemapKind}
            layers={stagedLayers}
            onFeaturePick={draw.onCanvasFeaturePick}
            initialViewport={map.viewport}
            onViewportChange={persistViewport}
            fitBounds={fitBounds}
            flyTo={flyTo}
            searchMarker={searchMarker}
            onSearchMarkerDismiss={dismissSearchMarker}
            onStatus={statusChannel.emit}
            onLabelCounts={onLabelCounts}
            onBasemapGroups={setLoadedBasemapGroups}
            customBasemap={effBasemap.custom}
            fallbackColor={BASEMAP_FALLBACKS[theme]}
            liveFilters={canvasDims}
            onLiveRangeSetter={live.onLiveRangeSetter}
            onHeatmapPreviewSetter={registerHeatmapPreview}
            timelineOpen={timeline.bar !== null}
            onZoomHandle={(handle) => {
              zoomHandleRef.current = handle;
              setDrawCamera(handle);
            }}
            onBearingChange={setMapBearing}
            onPitchChange={setMapPitch}
            onSnapshotHandle={onSnapshotHandle}
            padding={{
              top: 62,
              // Both edges read from the properties that define them, never
              // repeated here: a thirteenth copy of the number is how the
              // camera ends up framing a layout that no longer exists. They
              // arrive as one commit.
              right: stageEdges.right,
              bottom: 14,
              left: stageEdges.left,
            }}
          />
        </div>

        <div className={styles.canvasCol}>
        {/* The export card's "current view" measures THIS box — the map
            window the author actually sees (the map layer behind it is
            full-viewport and merely clip-pathed). */}
        <div className={styles.canvas} data-drag-canvas ref={mapLayerRef}>
          {querySliderApproximate && (
            <div className={styles.previewBadge}>Approximate preview</div>
          )}
          {/* The docked timeline: bottom-center, over the map, between
              the corner overlays. */}
          {timeline.bar && (
            <div className={styles.timelineDock} ref={setTimelineDockEl}>
              <TimelineBar {...timeline.bar} />
            </div>
          )}
          <BuilderLegendCorners
            legendCorner={legendCornerEff}
            legendDocked={legendDocked}
            legendLayers={legendLayers}
            dragPreview={dragPreview}
            onPreview={setDragPreview}
            onDrop={(legendCorner) => void patchMap({ legendCorner })}
            onTextClick={onLegendTextClick}
            onLabelEdit={onLegendLabelEdit}
            bottomLeftRef={setBottomCornerEl}
            bottomRightRef={setBottomRightCornerEl}
            cornerLift={cornerLift}
            creditLift={creditLift}
            statusPillHidden={statusPillHidden}
          />
          {/* The widget rail: the dashboard column on the stage's right
              edge. Cards drag to reorder; each carries a ⋮ menu; a
              right-corner legend docks in and drags back out. */}
          {railVisible && (
            <WidgetRail
              widgets={visibleWidgets}
              widgetsOnlyRef={setWidgetStackEl}
              values={dash.values}
              valuesState={dash.valuesState}
              onRetryValues={dash.retryValues}
              selections={dash.selections}
              onToggleCategory={dash.toggleCategory}
              onBrush={dash.brushRange}
              onClear={dash.clearSelection}
              onOptions={widgetList.openOptions}
              onDelete={widgetList.remove}
              onReorder={widgetList.reorderVisible}
            >
              {legendDocked && (
                <div data-no-dnd>
                  <CornerDrag
                    corner={legendCornerEff}
                    onPreview={setDragPreview}
                    onDrop={(legendCorner) => void patchMap({ legendCorner })}
                  >
                    <LegendPanel
                      layers={legendLayers}
                      docked={legendPlacement.width === "rail"}
                      onTextClick={onLegendTextClick}
                      onLabelEdit={onLegendLabelEdit}
                    />
                  </CornerDrag>
                </div>
              )}
            </WidgetRail>
          )}
          {dash.hint && <div className={widgetStyles.hint}>{dash.hint}</div>}
          <SettleStatus
            states={dash.settleStates}
            layerNames={Object.fromEntries(
              (map?.layers ?? []).map((l) => [l.id, l.name]),
            )}
            audience="author"
            onRetry={dash.retrySettle}
          />
          <BuilderStageControls
            cameraRef={zoomHandleRef}
            bearing={mapBearing}
            pitch={mapPitch}
            onFitAll={fitAll}
            mapFull={mapFull}
            onMapFull={setMapFull}
            draw={draw}
            drawCamera={drawCamera}
            creditRef={setCreditEl}
            creditLift={creditLift}
            attribution={basemapCredit}
            saving={pendingSaves > 0}
            notice={importNotice}
          />
        </div>
        {/* Status pill: floats bottom-center inside the map card. */}
        {!statusPillHidden && (
          <StatusBar
            channel={statusChannel}
            records={widgetRecords}
            recordsState={dash.valuesState}
          />
        )}
      </div>

      {exportCard.seed && (
        <ExportImageCard
          stage={buildExportStage({
            map,
            appearance: theme,
            layers: stagedLayers,
            basemapUrl: effectiveBasemapUrl,
            basemapKind: effectiveBasemapKind,
            fallbackColor: BASEMAP_FALLBACKS[theme],
            liveFilters: canvasDims,
            seed: exportCard.seed,
            legendLayers,
            widgets: resolvableWidgets,
            values: dash.values,
            valuesState: dash.valuesState,
            selections: dash.selections,
            attribution: basemapCredit,
          })}
          onClose={exportCard.close}
        />
      )}

      <CatalogHost
        sources={layerSources}
        failures={failures}
        viewport={map.viewport}
        projectId={mapProjectId}
      />

    </div>
  );
}

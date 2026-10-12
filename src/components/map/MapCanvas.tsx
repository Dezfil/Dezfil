"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  type FeaturePickHandler,
  type HoverInfo,
  type PinnedPopup,
} from "./canvas-pointer";
import * as maplibregl from "@/lib/maplibre";
import type { MapLibreOverlay } from "@deck.gl/maplibre";
import { attachCanvasOverlay } from "./canvas-overlay";
import type { Layer as DeckLayer } from "@deck.gl/core";
import {
  ArcLayer,
  GeoJsonLayer,
  IconLayer,
  ScatterplotLayer,
} from "@deck.gl/layers";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  LIVE_FILTER_SLOTS,
  dimFeatureValue,
  dimValues,
  dimRanges,
  type LiveDim,
} from "@/lib/live-filters";
import type { CaptureAtSize, SnapshotHandle } from "./capture";
import { useCameraRequests, type FlyRequest } from "./use-camera-requests";
import { useSearchMarker, type SearchMarkerRequest } from "./use-search-marker";
import {
  representativeColor,
  type LayerStyle,
} from "@/lib/style/style";
import {
  buildClusterIndex,
  clusterBubbles,
  type ClusterBubble,
  type ClusterIndex,
} from "@/lib/cluster";
import {
  deckLayerProps,
  deckUpdateTriggers,
  extrusionScale,
  extrusionProps,
  fillAccessor,
  cellLabelMeters,
  layerOpacity,
  odLayerProps,
  odUpdateTriggers,
  opaqueFillPaint,
  sizeAccessor,
} from "@/lib/style/deck-style";
import { createLabelStore } from "./label-data";
import { clusterCountSublayer, textSublayer, type LiveWindowing } from "./text-sublayer";
import { useLabelFont } from "./label-font";
import { useLabelPreparation } from "./use-label-preparation";
import type { LabelCount } from "../builder/style-panel/LabelSection";

import { iconSource } from "./icon-source";
import { sequentialColors, DEFAULT_SEQUENTIAL } from "@/lib/style/palettes";
import type { HeatmapViz, LayerViz } from "@/lib/viz";
import {
  heatmapLayerId,
  heatmapTextureSize,
  isHeatmapLayerId,
} from "@/lib/heatmap-quality";
import { BASEMAP_FALLBACK_COLOR, type BasemapKind } from "@/lib/basemap";
import type { BasemapLayerGroup, BasemapLayers } from "@/lib/basemap-layers";
import { useBasemapContent } from "./use-basemap-content";
import type { Bounds } from "@/lib/geo-bounds";
import type { MapStatus } from "@/lib/map-status";
import { useBasemapStyle } from "./use-basemap-style";
import { MapPopup, MapTooltip } from "./MapPopup";
import styles from "./MapCanvas.module.css";
import { cameraHandle, type CameraHandle } from "./camera-handle";
import { attemptInitialWebGLMap } from "./initial-webgl-failure";
import { createTiledLayer } from "./tiled-layer";
import { attachCanvasMotion, attachCanvasNotifications } from "./canvas-notifications";
import { attachCanvasCamera, CANVAS_CAMERA_OPTIONS } from "./canvas-camera";
import { BasemapOfflineNotice } from "./BasemapOfflineNotice";

export interface RenderedLayer {
  id: string;
  /** Ready to draw — an aggregated layer's fill is already its cell fill. */
  style: LayerStyle;
  visible: boolean;
  /** Tooltip fields; null/undefined = automatic (first few properties). */
  tooltip?: string[] | null;
  /** Click pop-up fields; null/undefined = automatic. */
  popup?: string[] | null;
  /** Client-drawn viz types (heatmap) need their config; others render as
   * plain GeoJSON. Absent = points. */
  viz?: LayerViz;
  geojson: unknown;
  /** Vector tiles for an over-cap layer: set when ready. Takes
   * precedence over geojson — a tiled layer has no inline data. */
  tiles?: { url: string; minZoom?: number; maxZoom?: number } | null;
}

interface HeatPoint {
  position: [number, number];
  weight: number;
  /** The layer's live-dimension values for this point, carried
   * so window and slider moves can refilter without re-reading the GeoJSON. */
  v?: number[];
}

/** One origin→destination row: the render result's two-point
 * line unpacked for the arc layer, properties kept for styling, tooltips,
 * and live filtering. */
interface OdSegment {
  source: [number, number];
  target: [number, number];
  properties: Record<string, unknown>;
}

/** One icon-rendered point: position plus properties for
 * styling, tooltips, and live filtering. */
interface IconPoint {
  position: [number, number];
  properties: Record<string, unknown>;
}

function iconPoints(geojson: unknown): IconPoint[] {
  const fc = geojson as {
    features?: {
      geometry?: { type?: string; coordinates?: unknown } | null;
      properties?: Record<string, unknown> | null;
    }[];
  };
  const out: IconPoint[] = [];
  for (const f of fc?.features ?? []) {
    if (f.geometry?.type !== "Point") continue;
    out.push({
      position: f.geometry.coordinates as [number, number],
      properties: f.properties ?? {},
    });
  }
  return out;
}

function odSegments(geojson: unknown): OdSegment[] {
  const fc = geojson as {
    features?: {
      geometry?: { type?: string; coordinates?: unknown } | null;
      properties?: Record<string, unknown> | null;
    }[];
  };
  const out: OdSegment[] = [];
  for (const f of fc?.features ?? []) {
    if (f.geometry?.type !== "LineString") continue;
    const coords = f.geometry.coordinates as [number, number][];
    if (!Array.isArray(coords) || coords.length < 2) continue;
    out.push({
      source: coords[0],
      target: coords[coords.length - 1],
      properties: f.properties ?? {},
    });
  }
  return out;
}

export type HeatmapPreviewSource = "viz" | "filter";

/** Imperative heatmap interaction channel. Draft settings and quality never
 * enter the durable layer model; `accepted: false` restores settled ranges. */
export type HeatmapPreviewSetter = (
  layerId: string,
  source: HeatmapPreviewSource,
  active: boolean,
  options?: { viz?: HeatmapViz; accepted?: boolean },
) => void;

/** One shared GPU filter, fixed at the slot maximum: the extension object
 * never changes shape, so a layer's deck id only changes when it gains or
 * loses its first live dimension. Unused slots pass their padded values
 * by construction. */
const LIVE_FILTER_EXTENSION = new DataFilterExtension({
  filterSize: LIVE_FILTER_SLOTS,
});

/** Heatmaps draw the layer's point features as a density surface. With live
 * dimensions given, each point carries its values so window and slider
 * moves can refilter without touching the GeoJSON again. */
function heatPoints(
  geojson: unknown,
  weight: string | null,
  dims?: LiveDim[] | null,
): HeatPoint[] {
  const fc = geojson as {
    features?: {
      geometry?: { type?: string; coordinates?: unknown } | null;
      properties?: Record<string, unknown> | null;
    }[];
  };
  const out: HeatPoint[] = [];
  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const raw = weight ? Number(f.properties?.[weight]) : 1;
    const w = Number.isFinite(raw) ? raw : 0;
    const v = dims?.length
      ? dims.map((d) => dimFeatureValue(d, f.properties?.[d.field]))
      : undefined;
    if (g.type === "Point") {
      out.push({ position: g.coordinates as [number, number], weight: w, v });
    } else if (g.type === "MultiPoint") {
      for (const c of g.coordinates as [number, number][]) {
        out.push({ position: c, weight: w, v });
      }
    }
  }
  return out;
}

/** Heatmap live-step cadence: each step recomputes
 * the weights attribute and re-aggregates the density surface — cheap,
 * but deck still re-creates its weights transform per attribute change,
 * so the playhead and slider channels step instead of running at
 * pointer-move rate. */
const HEAT_STEP_MS = 100;

/** Whether a point passes every live range. Live filtering of a heatmap
 * ZEROES WEIGHTS instead of slicing the data: a zero-weight point adds
 * nothing to the density surface, and the stable data array keeps deck
 * from re-uploading every attribute and re-running its full pipeline on
 * each step — only the weights recompute. The GPU aggregation itself
 * cannot compose with the data filter. */
function heatPasses(p: HeatPoint, ranges: [number, number][]): boolean {
  return (p.v ?? []).every((val, i) => {
    const r = ranges[i];
    return !r || (val >= r[0] && val <= r[1]);
  });
}

/** Heatmap ramp: the default sequential palette (kepler's Global Warming). */
const HEAT_COLOR_RANGE = sequentialColors(6, DEFAULT_SEQUENTIAL, false).map(
  (c) => [c.r, c.g, c.b] as [number, number, number],
);

export interface Viewport {
  lng: number;
  lat: number;
  zoom: number;
  /** Camera tilt in degrees; absent = 0, flat. */
  pitch?: number;
  /** Camera rotation in degrees; absent = 0, north-up. */
  bearing?: number;
}

interface Props {
  basemapUrl: string;
  /** Hidden basemap content groups; null/absent = all visible. */
  basemapLayers?: BasemapLayers | null;
  /** The active style's kind. Group toggles act on vector
   * styles only — on imagery they're skipped entirely, so no saved toggle
   * can blank the photo. Absent = vector (every earlier caller). */
  basemapKind?: BasemapKind;
  layers: RenderedLayer[];
  initialViewport: Viewport;
  interactive?: boolean;
  /**
   * The input picker's Select mode. Called with the clicked feature's
   * owning app layer BEFORE cluster zoom and popup handling; returning
   * true consumes the click. Read through a ref so the long-lived deck
   * handler always sees the current armed state.
   */
  onFeaturePick?: FeaturePickHandler;
  /** Scales the pixel values the canvas mints itself — mark floors,
   * halo rims, cluster chrome. The export composition draws in a larger
   * space and pins the authored channels; this carries the same rule to
   * the constants no layer record holds. Default 1: the builder and the
   * published view are untouched. */
  markScale?: number;
  onViewportChange?: (v: Viewport) => void;
  /** Set to a new object to trigger a fit-to-bounds animation. */
  fitBounds?: Bounds | null;
  /** Set to a new object to fly to a point at its zoom —
   * a search result's landing. Builder-only. */
  flyTo?: FlyRequest | null;
  /** The transient search marker; null shows none. */
  searchMarker?: SearchMarkerRequest | null;
  onSearchMarkerDismiss?: () => void;
  /** Live view status — cursor, zoom, bounds — for the builder's status
   * bar, coalesced to animation frames. Published views pass nothing and
   * nothing extra is bound. */
  onStatus?: (status: MapStatus) => void;
  /** Which content groups the loaded style actually yields,
   * reported on each style load — the basemap panel marks the rest
   * "not in this style" while a custom style is active. Null when the
   * offline fallback is showing: a failed style's groups are unknown. */
  onBasemapGroups?: (groups: BasemapLayerGroup[] | null) => void;
  /** The style is the map's custom URL: a load failure is
   * worded as that map's own style dying, not as the app being offline. */
  customBasemap?: boolean;
  /** The renderer-settled label counts per layer for the
   * builder's honest count line; published views pass nothing. */
  onLabelCounts?: (counts: Record<string, LabelCount | null>) => void;
  /** Background while/if basemap tiles are unreachable; themed by the
   * builder, constant on published views. */
  fallbackColor?: string;
  /** Client-side live filtering: each layer's GPU dimensions
   * with their settled ranges — features outside a range are hidden on the
   * GPU; the data is untouched. */
  liveFilters?: Record<string, LiveDim[]> | null;
  /** Receives an imperative range setter once the canvas is ready — slider
   * drags and the playback loop drive one dimension of one layer per frame
   * without React re-renders. */
  onLiveRangeSetter?: (
    set: (layerId: string, field: string, range: [number, number]) => void,
  ) => void;
  /** Receives the transient heatmap interaction setter. */
  onHeatmapPreviewSetter?: (set: HeatmapPreviewSetter) => void;
  /** True while the map-bottom timeline widget is open: fit
   * keeps the frame clear of it. */
  timelineOpen?: boolean;
  /** Persistent view padding: the builder renders the canvas
   * full-viewport behind a clipped card window, so centering, fit, and the
   * stored viewport target the visible window, not the whole canvas.
   * Changes animate; fitBounds adds these insets to its own margin. */
  padding?: { top: number; right: number; bottom: number; left: number };
  /** Receives imperative zoom methods once the map exists; null on teardown. */
  onZoomHandle?: (handle: CameraHandle | null) => void;
  /** Reports the view's bearing (integer degrees) whenever it changes —
   * drives the builder's compass needle. Published views pass nothing. */
  onBearingChange?: (bearing: number) => void;
  /** Reports the view's pitch (integer degrees) whenever it changes —
   * drives the tilt toggle's state and the status bar. */
  onPitchChange?: (pitch: number) => void;
  /** Receives a snapshot capture once the map exists; null on teardown
   * Capturing composites the basemap and deck canvases into one
   * downscaled PNG — the maps screen's card image. Passing this prop
   * turns on preserved drawing buffers, so only the builder should. */
  onSnapshotHandle?: SnapshotHandle;
  /** Receives the validated full-resolution capture once the map exists;
   * null on teardown. Only the export card passes this. */
  onCaptureHandle?: (capture: CaptureAtSize | null) => void;
  /** Readiness for the bare render route: the map idle with
   * its committed deck layer set fully loaded. */
  onReadiness?: (ready: boolean) => void;
  /** The one handled startup failure: initial MapLibre WebGL
   * context creation. Later renderer failures keep their normal path. */
  onInitialWebGLFailure?: (message: string) => void;
}

export function MapCanvas({
  basemapUrl,
  basemapLayers = null,
  basemapKind = "vector",
  layers,
  initialViewport,
  interactive = true,
  onFeaturePick,
  markScale = 1,
  onViewportChange,
  fitBounds,
  flyTo = null,
  searchMarker = null,
  onSearchMarkerDismiss,
  onStatus,
  onBasemapGroups,
  customBasemap = false,
  onLabelCounts,
  fallbackColor = BASEMAP_FALLBACK_COLOR,
  liveFilters = null,
  onLiveRangeSetter,
  onHeatmapPreviewSetter,
  timelineOpen = false,
  onZoomHandle,
  onBearingChange,
  onPitchChange,
  onSnapshotHandle,
  onCaptureHandle,
  onReadiness,
  onInitialWebGLFailure,
  padding,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapLibreOverlay | null>(null);
  const [initialWebGLFailure, setInitialWebGLFailure] = useState<string | null>(
    null,
  );
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [pinned, setPinned] = useState<PinnedPopup | null>(null);
  const pinnedRef = useRef<PinnedPopup | null>(null);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);
  // The basemap style lifecycle — swap, offline fallback, reactive
  // recolor — lives in its own module.
  const { basemapFailed, attach: attachBasemapStyle } = useBasemapStyle(
    map,
    basemapUrl,
    fallbackColor,
  );
  // Handlers are bound once at init; they read current props through refs so
  // tooltip and basemap changes apply without re-initializing the map.
  const layersRef = useRef<RenderedLayer[]>(layers);
  const onFeaturePickRef = useRef(onFeaturePick);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);
  useEffect(() => {
    onFeaturePickRef.current = onFeaturePick;
  }, [onFeaturePick]);
  const fallbackColorRef = useRef(fallbackColor);
  useEffect(() => {
    fallbackColorRef.current = fallbackColor;
  }, [fallbackColor]);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);
  const onBearingChangeRef = useRef(onBearingChange);
  useEffect(() => {
    onBearingChangeRef.current = onBearingChange;
  }, [onBearingChange]);
  const onPitchChangeRef = useRef(onPitchChange);
  useEffect(() => {
    onPitchChangeRef.current = onPitchChange;
  }, [onPitchChange]);
  const onInitialWebGLFailureRef = useRef(onInitialWebGLFailure);
  useEffect(() => {
    onInitialWebGLFailureRef.current = onInitialWebGLFailure;
  }, [onInitialWebGLFailure]);

  // Live filtering. The settled dims arrive as a prop; moving ranges — a
  // slider drag, the playhead — mutate liveRangesRef through the
  // imperative setter: per frame, no React state, no data rebuild. The
  // last-built deck layers are kept so a frame only clones the touched
  // layer's instances with a fresh filter range.
  const liveFiltersRef = useRef<Record<string, LiveDim[]>>(liveFilters ?? {});
  const liveRangesRef = useRef<Record<string, [number, number][]>>({});
  const timelineOpenRef = useRef(timelineOpen);
  useEffect(() => {
    timelineOpenRef.current = timelineOpen;
  }, [timelineOpen]);
  const deckLayersRef = useRef<DeckLayer[]>([]);
  const heatBasesRef = useRef<
    Record<string, { key: unknown; shape: string; points: HeatPoint[] }>
  >({});
  // O→D segments and icon points cached per geojson identity: a color,
  // height, or glyph tick must never re-parse or re-upload data.
  const odBasesRef = useRef<
    Record<string, { key: unknown; segments: OdSegment[] }>
  >({});
  const iconBasesRef = useRef<
    Record<string, { key: unknown; points: IconPoint[] }>
  >({});
  const clusterBasesRef = useRef<
    Record<string, { key: unknown; shape: string; index: ClusterIndex }>
  >({});
  // Labels get the same treatment: a labelled layer was the one type
  // re-deriving its data on every appearance tick.
  const [labelStore] = useState(createLabelStore);
  // Clusters re-form per integer zoom; pan never re-clusters.
  const [clusterZoom, setClusterZoom] = useState(0);
  const clusterZoomRef = useRef(0);
  // The cluster index is queried at the LOGICAL zoom: the visual zoom
  // minus the export space's compensation. In a scaled composition the
  // camera sits log2(markScale) deeper to hold the ground, and a
  // floored query against that deeper zoom regrouped the points — the
  // picture's content, not its dress. The subtraction lands on exactly
  // the reference grouping; markScale 1 (the builder, the published
  // view) is the identity.
  const markScaleRef = useRef(markScale);
  const resyncClusterZoom = useRef<(() => void) | null>(null);
  useEffect(() => {
    markScaleRef.current = markScale;
    resyncClusterZoom.current?.();
  }, [markScale]);
  const heatPreviewsRef = useRef<
    Record<
      string,
      { sources: Set<HeatmapPreviewSource>; viz?: HeatmapViz }
    >
  >({});

  // Basemap group visibility. A style swap discards layout overrides, so
  // every freshly loaded style is snapshotted (its own default visibilities,
  // before we touch them) and the hidden groups re-applied — initial load,
  // basemap change, theme switch, offline fallback alike. The content-group
  // lifecycle lives in its own module: authored visibilities, group toggles,
  // and the loaded style's group report.
  const { attach: attachBasemapContent } = useBasemapContent(
    map,
    basemapUrl,
    basemapLayers,
    basemapKind,
    onBasemapGroups,
  );

  /** Windowing props when this layer has live dimensions; reads the refs
   * so per-frame updates and React rebuilds see the same ranges. */
  const liveWindowing = useCallback((l: RenderedLayer): LiveWindowing | null => {
    const dims = liveFiltersRef.current[l.id];
    if (!dims || dims.length === 0) return null;
    return {
      dims,
      // A `values` dim's selected set is part of the signature: changing
      // the selection recomputes the attribute, exactly like dims moving
      // within the fixed slots.
      trigger: dims
        .map(
          (d) =>
            `${d.kind}${d.exclude ? "!" : ""} ${d.field} ${d.values?.join(" ") ?? ""}`,
        )
        .join(", "),
      props: {
        getFilterValue: (f: {
          properties?: Record<string, unknown> | null;
        }) => dimValues(dims, f.properties),
        filterRange: dimRanges(
          liveRangesRef.current[l.id] ?? dims.map((d) => d.range),
        ),
        extensions: [LIVE_FILTER_EXTENSION],
      },
    };
  }, []);

  // The deterministic thinning half lives in its own hook; counts flush
  // after each build below. Labels draw once their face has loaded.
  const labelFont = useLabelFont();
  const { prepareLabels, flushLabelCounts, resetLabelCounts } =
    useLabelPreparation(
    labelStore,
    clusterZoomRef,
    onLabelCounts,
  );

  const buildDeckLayers = useCallback(
    (rendered: RenderedLayer[]) => {
      // Reset counts: hidden or re-vized layers must not retain an old count.
      resetLabelCounts();
      const built = rendered
        .filter((l) => l.visible && (l.geojson || l.tiles?.url))
        .flatMap((l): DeckLayer | DeckLayer[] => {
          const windowing = liveWindowing(l);
          // Extensions cannot be added to or removed from a live layer:
          // deck keeps per-id state, so losing the filter would leave its
          // attribute declared with the accessor gone (a hard assert), and
          // gaining one on a rendered layer would leave it inert. A
          // windowed layer therefore gets its own id — gaining or losing
          // the first live dimension re-creates it cleanly (the deck id
          // lesson, extended); dims changing within the fixed slots ride
          // on update triggers.
          const suffix = windowing ? ":windowed" : "";
          if (l.tiles?.url) {
            return createTiledLayer(l, { interactive, markScale, windowing, labelFont });
          }
          if (l.viz?.type === "heatmap") {
            // Density surface over the layer's points. Not pickable — a
            // heatmap has no discrete features to hover. The id is
            // namespaced by type: deck matches layers purely by id and
            // transfers state across renders, which crashes when the same id
            // switches layer class (GeoJsonLayer ⇄ HeatmapLayer).
            // Live-filtered: windowing rides getWeight — out-of-range points
            // weigh zero. The points array is cached and IDENTITY-STABLE
            // across rebuilds, so a radius or intensity tick never
            // re-uploads data; only a live-range change recomputes the
            // weights (keyed by the trigger below).
            const layerId = l.id;
            const preview = heatPreviewsRef.current[layerId];
            const heatViz = preview?.viz ?? l.viz;
            const shape = `${windowing?.trigger ?? ""} ${l.viz.weight ?? ""}`;
            const base = heatBasesRef.current[layerId];
            if (base?.key !== l.geojson || base?.shape !== shape) {
              heatBasesRef.current[layerId] = {
                key: l.geojson,
                shape,
                points: heatPoints(l.geojson, l.viz.weight, windowing?.dims),
              };
            }
            const ranges = () =>
              liveRangesRef.current[layerId] ??
              windowing!.dims.map((d) => d.range);
            return new HeatmapLayer<HeatPoint>({
              // deck.gl only reads weightsTextureSize while initializing
              // the layer. Distinct identities make adaptive quality real
              // instead of transferring the settled 2048 state into the
              // lower-resolution preview (manual-pass correction).
              id: heatmapLayerId(l.id, Boolean(preview?.sources.size)),
              data: heatBasesRef.current[layerId].points,
              getPosition: (d) => d.position,
              getWeight: windowing
                ? (d: HeatPoint) => (heatPasses(d, ranges()) ? d.weight : 0)
                : (d: HeatPoint) => d.weight,
              updateTriggers: {
                getWeight: windowing ? JSON.stringify(ranges()) : "",
              },
              radiusPixels: heatViz.radiusPx,
              intensity: heatViz.intensity,
              weightsTextureSize: heatmapTextureSize(
                Boolean(preview?.sources.size),
              ),
              colorRange: HEAT_COLOR_RANGE,
              opacity: layerOpacity(l.style.opacity),
              pickable: false,
            });
          }
          if (l.viz?.type === "cluster") {
            // Count-labeled bubbles from client-side clustering. Live
            // filters apply in JS before the index builds, so counts stay
            // truthful; the GPU filter extension deliberately stays off this
            // layer. Bubble size encodes count (sqrt scale); color is the
            // style fill or a sequential ramp over the current view's
            // aggregate values.
            const cViz = l.viz;
            const agg = cViz.color === "fixed" ? null : cViz.color;
            const dims = liveFiltersRef.current[l.id] ?? null;
            const ranges = dims
              ? (liveRangesRef.current[l.id] ?? dims.map((d) => d.range))
              : null;
            const rangesKey = ranges ? JSON.stringify(ranges) : "";
            const aggKey = agg ? JSON.stringify(agg) : "";
            const shape = `${cViz.radiusPx}|${aggKey}|${windowing?.trigger ?? ""}|${rangesKey}`;
            const base = clusterBasesRef.current[l.id];
            if (base?.key !== l.geojson || base.shape !== shape) {
              let pts = iconPoints(l.geojson);
              if (dims && ranges) {
                const padded = dimRanges(ranges);
                pts = pts.filter((p) =>
                  dimValues(dims, p.properties).every(
                    (v, i) => v >= padded[i][0] && v <= padded[i][1],
                  ),
                );
              }
              clusterBasesRef.current[l.id] = {
                key: l.geojson,
                shape,
                index: buildClusterIndex(pts, cViz.radiusPx, agg),
              };
            }
            const zoom = clusterZoomRef.current;
            const bubbles = clusterBubbles(
              clusterBasesRef.current[l.id].index,
              zoom,
              agg,
            );
            const maxCount = Math.max(1, ...bubbles.map((b) => b.count));
            const fixed = (() => {
              const c =
                l.style.fill.type === "constant"
                  ? l.style.fill.color
                  : representativeColor(l.style);
              const a = Math.min(1, Math.max(0, c.a * l.style.fillOpacity));
              return [c.r, c.g, c.b, Math.round(a * 255)] as [
                number,
                number,
                number,
                number,
              ];
            })();
            let getFillColor:
              | typeof fixed
              | ((b: ClusterBubble) => typeof fixed) = fixed;
            if (agg) {
              const stops = sequentialColors(6, DEFAULT_SEQUENTIAL);
              const values = bubbles
                .map((b) => b.value)
                .filter((v): v is number => v !== null);
              const lo = Math.min(...values);
              const hi = Math.max(...values);
              getFillColor = (b: ClusterBubble) => {
                const alpha = Math.round(
                  Math.min(1, Math.max(0, l.style.fillOpacity)) * 255,
                );
                if (b.value === null || !Number.isFinite(lo) || hi === lo) {
                  const c = stops[stops.length - 1];
                  return [c.r, c.g, c.b, alpha] as typeof fixed;
                }
                const t = (b.value - lo) / (hi - lo);
                const c =
                  stops[
                    Math.min(stops.length - 1, Math.floor(t * stops.length))
                  ];
                return [c.r, c.g, c.b, alpha] as typeof fixed;
              };
            }
            const bubbleLayer = new ScatterplotLayer({
              id: `${l.id}:cluster`,
              data: bubbles,
              pickable: interactive,
              autoHighlight: interactive,
              highlightColor: [95, 227, 171, 90],
              getPosition: (b: ClusterBubble) => b.position,
              getRadius: (b: ClusterBubble) =>
                b.clusterId === null
                  ? Math.max(l.style.pointRadius, 4 * markScale)
                  : (8 + 20 * Math.sqrt(b.count / maxCount)) * markScale,
              radiusUnits: "pixels",
              stroked: true,
              getLineColor: [255, 255, 255, 230],
              getLineWidth: 1.5 * markScale,
              lineWidthUnits: "pixels",
              getFillColor,
              opacity: layerOpacity(l.style.opacity),
              updateTriggers: {
                getFillColor: [aggKey, l.style.fill, l.style.fillOpacity, rangesKey, zoom],
                getRadius: [maxCount, l.style.pointRadius, zoom],
              },
            } as unknown as ConstructorParameters<typeof ScatterplotLayer>[0]);
            if (!cViz.showCounts || !labelFont) return bubbleLayer as unknown as DeckLayer;
            const counts = clusterCountSublayer(`${l.id}:cluster-counts`, bubbles, markScale,
              layerOpacity(l.style.opacity), [zoom, rangesKey], labelFont);
            return [
              bubbleLayer as unknown as DeckLayer,
              counts as unknown as DeckLayer,
            ];
          }
          if (l.viz?.type === "icon") {
            // Points as a tinted glyph from the bundled Maki subset. Size
            // rides the point-radius channel (diameter-ish), color the
            // fill channel; the SVG is rasterized generously and used as
            // an alpha mask so data-driven color applies.
            const glyph = l.viz.glyph;
            const customSvg = l.viz.customSvg ?? null;
            const base = iconBasesRef.current[l.id];
            if (base?.key !== l.geojson) {
              iconBasesRef.current[l.id] = {
                key: l.geojson,
                points: iconPoints(l.geojson),
              };
            }
            const sizeBy = l.style.pointRadiusBy
              ? sizeAccessor(l.style.pointRadiusBy, "sqrt")
              : null;
            // Glyphs tint at full color alpha — the authored fill alpha is
            // an area-mark convention the picker can't even edit.
            const fill = fillAccessor(
              opaqueFillPaint(l.style.fill),
              l.style.fillOpacity,
            );
            // Once per layer — deck evaluates getIcon per datum.
            const source = iconSource(glyph, customSvg);
            const icons = new IconLayer({
              id: `${l.id}:icon${suffix}`,
              data: iconBasesRef.current[l.id].points,
              pickable: interactive,
              autoHighlight: interactive,
              highlightColor: [95, 227, 171, 90],
              getPosition: (d: IconPoint) => d.position,
              getIcon: () => source,
              getSize: sizeBy
                ? (d: IconPoint) => sizeBy(d) * 2
                : Math.max(l.style.pointRadius * 2, 4 * markScale),
              getColor: typeof fill === "function" ? (d: IconPoint) => fill(d) : fill,
              sizeUnits: "pixels",
              sizeMinPixels: 4 * markScale,
              opacity: layerOpacity(l.style.opacity),
              ...(windowing?.props ?? {}),
              updateTriggers: {
                getIcon: [glyph, customSvg],
                getSize: [l.style.pointRadius, l.style.pointRadiusBy],
                getColor: [l.style.fill, l.style.fillOpacity],
                ...(windowing ? { getFilterValue: windowing.trigger } : null),
              },
            } as unknown as ConstructorParameters<typeof IconLayer>[0]);
            const iconLabel = l.style.label;
            const iconLabeled = iconLabel ? prepareLabels(l, iconLabel, windowing) : [];
            return iconLabeled.length && labelFont
              ? [
                  icons as unknown as DeckLayer,
                  textSublayer(
                    `${l.id}:labels${suffix}`,
                    iconLabeled,
                    iconLabel!,
                    null,
                    windowing,
                    layerOpacity(l.style.opacity),
                    markScale,
                    labelFont,
                  ) as unknown as DeckLayer,
                ]
              : (icons as unknown as DeckLayer);
          }
          if (l.viz?.type === "arc" || l.viz?.type === "line") {
            // Origin→destination rows drawn as arcs; line is an arc of
            // height 0. Id namespaced by type (the deck lesson).
            const odViz = l.viz;
            const base = odBasesRef.current[l.id];
            if (base?.key !== l.geojson) {
              odBasesRef.current[l.id] = {
                key: l.geojson,
                segments: odSegments(l.geojson),
              };
            }
            const arcs = new ArcLayer({
              id: `${l.id}:od${suffix}`,
              data: odBasesRef.current[l.id].segments,
              pickable: interactive,
              autoHighlight: interactive,
              highlightColor: [95, 227, 171, 90],
              getSourcePosition: (d: OdSegment) => d.source,
              getTargetPosition: (d: OdSegment) => d.target,
              ...odLayerProps(l.style, odViz, markScale),
              ...(windowing?.props ?? {}),
              updateTriggers: {
                ...odUpdateTriggers(l.style, odViz),
                ...(windowing ? { getFilterValue: windowing.trigger } : null),
              },
            } as unknown as ConstructorParameters<typeof ArcLayer>[0]);
            const odLabel = l.style.label;
            const odLabeled = odLabel ? prepareLabels(l, odLabel, windowing) : [];
            return odLabeled.length && labelFont
              ? [
                  arcs as unknown as DeckLayer,
                  textSublayer(
                    `${l.id}:labels${suffix}`,
                    odLabeled,
                    odLabel!,
                    null,
                    windowing,
                    layerOpacity(l.style.opacity),
                    markScale,
                    labelFont,
                  ) as unknown as DeckLayer,
                ]
              : (arcs as unknown as DeckLayer);
          }
          // Extrusion: cells rise by the viz elevation, simple polygons by
          // the style's height channel; null renders flat, exactly as
          // before.
          const extrusion = extrusionScale(l.style, l.viz);
          const marks = new GeoJsonLayer({
            id: `${l.id}${suffix}`,
            data: l.geojson as never,
            pickable: interactive,
            autoHighlight: interactive,
            highlightColor: [95, 227, 171, 90],
            ...deckLayerProps(l.style, markScale),
            ...(extrusion ? extrusionProps(extrusion) : null),
            ...(windowing?.props ?? {}),
            updateTriggers: {
              ...deckUpdateTriggers(l.style),
              ...(extrusion ? { getElevation: [extrusion] } : null),
              ...(windowing ? { getFilterValue: windowing.trigger } : null),
            },
          } as ConstructorParameters<typeof GeoJsonLayer>[0]);
          const label = l.style.label;
          const labeled = label ? prepareLabels(l, label, windowing) : [];
          return labeled.length && labelFont
            ? [
                marks as unknown as DeckLayer,
                textSublayer(
                  `${l.id}:labels${suffix}`,
                  labeled,
                  label!,
                  cellLabelMeters(l.viz),
                  windowing,
                  layerOpacity(l.style.opacity),
                  markScale,
                  labelFont,
                ) as unknown as DeckLayer,
              ]
            : (marks as unknown as DeckLayer);
        });
      labelStore.sweep();
      return built;
    },
    [interactive, prepareLabels, resetLabelCounts, labelStore, liveWindowing, markScale, labelFont],
  );

  const paddingKey = padding ? JSON.stringify(padding) : null;
  const initialPaddingRef = useRef(padding);

  // Initialize the map once.
  useEffect(() => {
    if (!container.current || map.current) return;
    const attempted = attemptInitialWebGLMap(
      () =>
        new maplibregl.Map({
          container: container.current!,
          style: basemapUrl,
          center: [initialViewport.lng, initialViewport.lat],
          zoom: initialViewport.zoom,
          pitch: initialViewport.pitch ?? 0,
          bearing: initialViewport.bearing ?? 0,
          ...CANVAS_CAMERA_OPTIONS,
          interactive,
          attributionControl: false,
        }),
    );
    if (!attempted.ok) {
      // Keep the stable host empty for React's accessible local failure.
      // MapLibre cleans its failed constructor's DOM; this replacement is
      // harmless when the renderer has already removed every child.
      container.current.replaceChildren();
      setInitialWebGLFailure(attempted.message);
      onReadiness?.(false);
      onInitialWebGLFailureRef.current?.(attempted.message);
      return;
    }
    const instance = attempted.value;
    // Applied before first paint, so the stored center lands at the padded
    // (visible-window) center — the same point the pre-padding builder
    // showed at its card's center.
    if (initialPaddingRef.current) instance.setPadding(initialPaddingRef.current);
    map.current = instance;

    const disposeCamera = attachCanvasCamera(instance, container.current, initialViewport);

    // Basemap unreachable (offline / air-gapped): the lifecycle module
    // falls back to a plain background; data layers still render.
    attachBasemapStyle(instance);

    attachBasemapContent(instance);

    const motion = attachCanvasMotion(instance, markScaleRef, clusterZoomRef, setClusterZoom);
    resyncClusterZoom.current = motion.syncClusterZoom;

    const mountedOverlay = attachCanvasOverlay({
      instance,
      interactive,
      isDragging: motion.isDragging,
      pinnedRef,
      layersRef,
      markScaleRef,
      onFeaturePickRef,
      setHover,
      setPinned,
    }, {
      fallbackColor: () => fallbackColorRef.current,
      deckLayers: () => deckLayersRef.current,
      expectedLayerCount: () => layersRef.current.length,
      onSnapshotHandle,
      onCaptureHandle,
      onReadiness,
    });
    overlay.current = mountedOverlay.overlay;
    // No native navigation control on any surface: both the builder and
    // the published view draw the shared stage stack, so the stock
    // cluster was a second, differently-styled compass — and on the
    // published side it vanished whenever the widget rail appeared. The
    // CSS-only reduced-motion rule cannot reach camera eases; the new
    // tilt motion carries its own guard.
    onZoomHandle?.(cameraHandle(instance, () => liveRangesRef.current));

    const disposeNotifications = attachCanvasNotifications({
      instance, onBearingChangeRef, onPitchChangeRef, onViewportChange,
      pinnedRef, setPinned, onStatusRef,
    });

    return () => {
      disposeNotifications();
      motion.dispose();
      onZoomHandle?.(null);
      mountedOverlay.dispose();
      disposeCamera();
      instance.remove();
      map.current = null;
      overlay.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the visible window: the dock claiming or ceding the bottom
  // strip glides the view to keep the centered content centered — a pure
  // pan, no canvas resize. Deliberately NOT keyed to fullscreen: entering
  // fullscreen must not move a single map pixel.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !paddingKey) return;
    const next = JSON.parse(paddingKey) as {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
    const cur = instance.getPadding();
    if (
      cur.top === next.top &&
      cur.right === next.right &&
      cur.bottom === next.bottom &&
      cur.left === next.left
    ) {
      return;
    }
    instance.easeTo({ padding: next, duration: 300 });
  }, [paddingKey]);


  // Push layers to the overlay whenever they change; cached heat points
  // for layers that no longer exist go with them.
  useEffect(() => {
    const ids = new Set(layers.map((l) => l.id));
    for (const id of Object.keys(heatBasesRef.current)) {
      if (!ids.has(id)) {
        delete heatBasesRef.current[id];
        delete heatPreviewsRef.current[id];
      }
    }
    for (const cache of [odBasesRef, iconBasesRef, clusterBasesRef]) {
      for (const id of Object.keys(cache.current)) {
        if (!ids.has(id)) delete cache.current[id];
      }
    }
    const built = buildDeckLayers(layers);
    deckLayersRef.current = built;
    overlay.current?.setProps({ layers: built });
    flushLabelCounts();
  }, [layers, buildDeckLayers, flushLabelCounts]);

  // Integer-zoom crossings re-form cluster bubbles; other layers are
  // untouched (their instances rebuild cheaply from cached data).
  useEffect(() => {
    if (
      !layersRef.current.some(
        (l) => l.viz?.type === "cluster" || l.style.label?.zoomFloor != null,
      )
    )
      return;
    const built = buildDeckLayers(layersRef.current);
    deckLayersRef.current = built;
    overlay.current?.setProps({ layers: built });
    flushLabelCounts();
  }, [clusterZoom, buildDeckLayers, flushLabelCounts]);

  // Settled-dimension changes — a filter added, removed, or committed —
  // rebuild the affected layers' windowing. Keyed by value, not object
  // identity, so parent re-renders are free. The settled state is the
  // authority: live ranges reset to it here.
  const liveKey = JSON.stringify(liveFilters ?? {});
  useEffect(() => {
    const dims = liveFilters ?? {};
    liveFiltersRef.current = dims;
    const ranges: Record<string, [number, number][]> = {};
    for (const [id, layerDims] of Object.entries(dims)) {
      ranges[id] = layerDims.map((d) => d.range);
    }
    liveRangesRef.current = ranges;
    const built = buildDeckLayers(layersRef.current);
    deckLayersRef.current = built;
    overlay.current?.setProps({ layers: built });
    flushLabelCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, buildDeckLayers]);

  // The live path: a slider drag or the playhead mutates one dimension's
  // range and clones only that layer's instances with a fresh filter range
  // — no React state, no attribute recompute, no data rebuild. The heatmap
  // recomputes its weights instead (its GPU aggregation ignores the
  // filter; zero weight = absent). Direct filter manipulation is
  // frame-coalesced at preview quality; timeline playback retains its
  // bounded settled-quality cadence.
  const heatStepRef = useRef<
    Record<
      string,
      {
        last: number;
        timer: ReturnType<typeof setTimeout> | null;
        frame: number | null;
      }
    >
  >({});
  useEffect(() => {
    const steps = heatStepRef.current;
    return () => {
      for (const step of Object.values(steps)) {
        if (step.timer) clearTimeout(step.timer);
        if (step.frame !== null) cancelAnimationFrame(step.frame);
      }
    };
  }, []);

  const applyHeatStep = useCallback((layerId: string) => {
    const ranges = liveRangesRef.current[layerId];
    if (!ranges || !overlay.current) return;
    let changed = false;
    deckLayersRef.current = deckLayersRef.current.map((ly) => {
      if (!isHeatmapLayerId(String(ly.id), layerId)) return ly;
      changed = true;
      // Same data, same accessor — the trigger alone recomputes the
      // weights, which read the fresh ranges through the ref.
      return ly.clone({
        updateTriggers: { getWeight: JSON.stringify(ranges) },
      } as never);
    });
    if (changed) overlay.current.setProps({ layers: deckLayersRef.current });
  }, []);

  const cancelHeatStep = useCallback((layerId: string) => {
    const step = heatStepRef.current[layerId];
    if (!step) return;
    if (step.timer) clearTimeout(step.timer);
    if (step.frame !== null) cancelAnimationFrame(step.frame);
    step.timer = null;
    step.frame = null;
  }, []);

  const setHeatmapPreview = useCallback<HeatmapPreviewSetter>(
    (layerId, source, active, options = {}) => {
      const previous = heatPreviewsRef.current[layerId];
      const heatmap = layersRef.current.some(
        (layer) => layer.id === layerId && layer.viz?.type === "heatmap",
      );
      if (!previous && !heatmap) return;
      const sources = new Set(previous?.sources ?? []);
      let previewViz = previous?.viz;
      if (active) {
        sources.add(source);
        if (options.viz) previewViz = options.viz;
      } else {
        sources.delete(source);
        if (source === "viz") previewViz = undefined;
      }
      const nextPreviews = { ...heatPreviewsRef.current };
      if (sources.size === 0) delete nextPreviews[layerId];
      else nextPreviews[layerId] = { sources, viz: previewViz };
      heatPreviewsRef.current = nextPreviews;

      // A filter release must render the newest range, not a pending frame.
      // Rejected persistence restores the authoritative settled dimensions.
      if (source === "filter" && !active) {
        cancelHeatStep(layerId);
        if (options.accepted === false) {
          const dims = liveFiltersRef.current[layerId];
          if (dims) liveRangesRef.current[layerId] = dims.map((d) => d.range);
        }
        applyHeatStep(layerId);
      }

      const previewing = sources.size > 0;
      let changed = false;
      deckLayersRef.current = deckLayersRef.current.map((layer) => {
        if (!isHeatmapLayerId(String(layer.id), layerId)) return layer;
        changed = true;
        const viz = options.viz;
        return layer.clone({
          id: heatmapLayerId(layerId, previewing),
          ...(viz
            ? { radiusPixels: viz.radiusPx, intensity: viz.intensity }
            : null),
          weightsTextureSize: heatmapTextureSize(previewing),
        } as never);
      });
      if (changed) overlay.current?.setProps({ layers: deckLayersRef.current });
    },
    [applyHeatStep, cancelHeatStep],
  );

  const setLiveRange = useCallback(
    (layerId: string, field: string, range: [number, number]) => {
      const dims = liveFiltersRef.current[layerId];
      if (!dims || !overlay.current) return;
      const idx = dims.findIndex((d) => d.field === field);
      if (idx === -1) return;
      const ranges = (liveRangesRef.current[layerId] ??
        dims.map((d) => d.range)).slice();
      ranges[idx] = range;
      liveRangesRef.current[layerId] = ranges;
      let changed = false;
      let heat = false;
      deckLayersRef.current = deckLayersRef.current.map((ly) => {
        const id = String(ly.id);
        if (id !== layerId && !id.startsWith(`${layerId}:`)) return ly;
        if (isHeatmapLayerId(id, layerId)) {
          heat = true; // stepped below, never per move
          return ly;
        }
        changed = true;
        return ly.clone({ filterRange: dimRanges(ranges) } as never);
      });
      if (changed) {
        overlay.current.setProps({ layers: deckLayersRef.current });
      }
      if (heat) {
        const step = (heatStepRef.current[layerId] ??= {
          last: 0,
          timer: null,
          frame: null,
        });
        if (heatPreviewsRef.current[layerId]?.sources.has("filter")) {
          // Interactive quality is cheap enough to follow the display: one
          // newest range per frame, with no queue of stale pointer moves.
          if (step.timer) {
            clearTimeout(step.timer);
            step.timer = null;
          }
          if (step.frame === null) {
            step.frame = requestAnimationFrame(() => {
              step.frame = null;
              step.last = performance.now();
              applyHeatStep(layerId);
            });
          }
        } else if (step.timer === null) {
          // Timeline playback has no rail-drag lifecycle yet; retain its
          // proven bounded cadence at settled quality.
          const wait = Math.max(0, step.last + HEAT_STEP_MS - performance.now());
          step.timer = setTimeout(() => {
            step.timer = null;
            step.last = performance.now();
            applyHeatStep(layerId);
          }, wait);
        }
      }
    },
    [applyHeatStep],
  );

  useEffect(() => {
    onLiveRangeSetter?.(setLiveRange);
  }, [onLiveRangeSetter, setLiveRange]);

  useEffect(() => {
    onHeatmapPreviewSetter?.(setHeatmapPreview);
  }, [onHeatmapPreviewSetter, setHeatmapPreview]);

  // Camera and marker requests: own modules; fit contract unchanged.
  useCameraRequests({ mapRef: map, fitBounds, flyTo, timelineOpenRef });
  useSearchMarker(map, searchMarker, onSearchMarkerDismiss);

  // Escape closes the pinned pop-up, viewer and builder alike.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);

  return (
    <div className={styles.wrap}>
      <div ref={container} className={styles.map} />
      {initialWebGLFailure && (
        <div
          className={styles.webglFailure}
          role="alert"
          data-map-webgl-failed=""
        >
          <div className={styles.webglFailureCard}>
            <strong>WebGL is unavailable</strong>
            <p>{initialWebGLFailure}</p>
          </div>
        </div>
      )}
      {basemapFailed && (
        <BasemapOfflineNotice customBasemap={customBasemap} padding={padding} />
      )}
      <MapTooltip hover={hover} />
      <MapPopup pinned={pinned} onClose={() => setPinned(null)} />
    </div>
  );
}

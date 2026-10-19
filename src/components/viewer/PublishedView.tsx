"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PublishedView as ViewData } from "@/lib/publish/publish-service";
import type { LayerRenderData } from "@/lib/layer-service";
import type { WidgetValues } from "@/lib/widget-service";
import type { LayerFilter } from "@/lib/viz";
import type { WidgetSelection } from "@/lib/widgets";
import type { RenderedLayer } from "../map/MapCanvas";
import { HintLayer } from "../ui/HintLayer";
import {
  orderForLegend,
  successfulLegendLayers,
} from "@/lib/style/legend-order";
import { LIVE_FILTER_SLOTS, type LiveDim } from "@/lib/live-filters";
import { WidgetRail } from "../widgets/WidgetRail";
import { SettleStatus } from "../widgets/SettleStatus";
import widgetStyles from "../widgets/Widgets.module.css";
import { readApiFailure } from "../api";
import {
  NETWORK_FAILURE,
  type EndpointResult,
} from "../widgets/dashboard-state";
import {
  useWidgetDashboard,
  type DashboardLayer,
} from "../widgets/use-widget-dashboard";
import { LegendPanel, type NamedStyle } from "../map/LegendPanel";
import { TimelineBar } from "../map/TimelineBar";
import { useLiftClearance } from "../map/use-lift-clearance";
import { useLegendPlacement } from "../map/use-legend-placement";
import type { Bounds } from "@/lib/geo-bounds";
import {
  effectiveExtent,
  mergeExtent,
  type ExtentLayer,
} from "@/lib/map-extent";
import { fetchPublishedExtent, msToTimeValue } from "./published-extent";
import {
  BASEMAPS,
  BASEMAP_FALLBACKS,
  basemapCreditIn,
  basemapKindIn,
  offeredOnly,
  type BasemapKey,
  type BasemapStyle,
} from "@/lib/basemap";
import { useSyncViewTheme, useViewTheme } from "./use-view-theme";
import { BasemapCredit } from "../map/BasemapCredit";
import { BasemapPicker } from "../map/BasemapPicker";
import { StageButton, StageStack } from "../map/StageStack";
import { FitIcon, MoonIcon, SunIcon } from "../ui/icons";
import type { CameraHandle } from "../map/camera-handle";
import { LogoMark } from "../LogoMark";
import { timeToMs, windowToRange, type TimeWindowMs } from "@/lib/time";
import { createStatusChannel } from "@/lib/map-status";
import { CursorReadout } from "./CursorReadout";
import { PublishedNotFound } from "./PublishedNotFound";
import { FailedLayers } from "./FailedLayers";
import styles from "./PublishedView.module.css";

const MapCanvas = dynamic(
  () => import("../map/MapCanvas").then((m) => m.MapCanvas),
  { ssr: false },
);

type Status = "loading" | "ok" | "notfound" | "error";

/** The reader's layers in the shared extent contract: what is
 * drawn, and under which constraints. Used by BOTH the initial framing and
 * the Fit control — a map that opened on the unfiltered extent and only
 * corrected itself when the reader pressed Fit would still open framing
 * rows it is not drawing. */
function readerExtentLayers(
  layers: ViewData["layers"],
  dims: Record<string, LiveDim[]>,
  staged: Record<string, LayerRenderData | undefined>,
  live: Record<string, [number, number][]>,
): ExtentLayer[] {
  return layers.map((l) => {
    const settle = staged[l.id];
    const drawn = settle?.ok && settle.geojson ? settle : l.render;
    const layerDims = dims[l.id] ?? [];
    const ranges = live[l.id];
    return {
      id: l.id,
      // The payload carries only the layers the author left visible.
      visible: true,
      geojson: drawn.ok ? (drawn.geojson ?? null) : null,
      tiles:
        drawn.ok && drawn.geojson
          ? null
          : l.render.ok
            ? (l.render.tiles?.bounds ?? null)
            : null,
      dims: ranges
        ? layerDims.map((d, i) => (ranges[i] ? { ...d, range: ranges[i] } : d))
        : layerDims,
    };
  });
}

export function PublishedView({
  token,
  basemapUrl,
  basemaps = BASEMAPS,
  embedded = false,
}: {
  token: string;
  basemapUrl: string;
  /** The styles this instance offers, server-injected. Imagery is
   * configured rather than shipped, so it is a picker card only where it
   * is configured. */
  basemaps?: BasemapStyle[];
  /** The generated embed's marked view: zoom, north and fit
   * only. An embed is usually small and sits inside someone else's page,
   * where a theme or basemap switch belongs to the host, not to us. */
  embedded?: boolean;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [view, setView] = useState<ViewData | null>(null);
  const [fitBounds, setFitBounds] = useState<Bounds | null>(null);
  // Live view status for the cursor readout — the builder's channel
  // pattern, so cursor motion re-renders only the readout.
  const [statusChannel] = useState(createStatusChannel);
  // Reader theme: a load-local switch over the authored default the route
  // stamped before paint — nothing is remembered, so every fresh load
  // opens the way the author currently publishes. The sync keeps the
  // wrapper's chrome scope on the effective theme, whether the reader
  // switched or a payload refresh carried an authored update.
  const { effective: effectiveViewTheme, toggle: toggleViewTheme, rootRef: viewerRootRef } = useViewTheme();
  // The reader's basemap, also load-local. `undefined` means untouched —
  // distinct from an explicit Auto, which is a choice the reader made.
  const [readerBasemap, setReaderBasemap] = useState<
    BasemapKey | null | undefined
  >(undefined);
  useSyncViewTheme(
    viewerRootRef,
    view ? effectiveViewTheme(view.theme ?? "dark") : null,
  );

  // Bumped to refetch while tiles are preparing.
  const [pollTick, setPollTick] = useState(0);
  // A refetch that fails leaves the view and the status as they were, so
  // it is counted instead: the poll waits on every read, failed or not.
  const [failedReads, setFailedReads] = useState(0);
  const framed = useRef(false);

  // The docked timeline, viewer side: everything a viewer does — scrub,
  // play, speed — is local state over the payload's block; nothing
  // persists. Seeded once per token so a tile poll can't reset a scrub.
  const [timeState, setTimeState] = useState<{
    window: TimeWindowMs;
    speed: number;
  } | null>(null);
  const timeSeeded = useRef(false);
  // Reader camera: the published camera restores the author's pitch, and
  // the stage stack drives zoom, north and tilt from the same handle the
  // builder uses.
  const cameraRef = useRef<CameraHandle | null>(null);
  const [pitch, setPitch] = useState(0);
  const [bearing, setBearing] = useState(0);
  // Fitting's own transient failure: a camera move that could not be
  // computed is not a layer or page failure, and it must not be silent
  // either.
  const [fitFailure, setFitFailure] = useState<string | null>(null);
  const fitSeqRef = useRef(0);
  // Bottom corner stacks lift above the docked timeline only when their
  // horizontal extents would actually collide, as a field round found.
  const [timelineDockEl, setTimelineDockEl] = useState<HTMLElement | null>(
    null,
  );
  const [cornerBLEl, setCornerBLEl] = useState<HTMLElement | null>(null);
  const [cornerBREl, setCornerBREl] = useState<HTMLElement | null>(null);
  const [legendCandidateEl, setLegendCandidateEl] =
    useState<HTMLElement | null>(null);
  const [widgetStackEl, setWidgetStackEl] = useState<HTMLElement | null>(null);
  const liftBL = useLiftClearance(timelineDockEl, cornerBLEl);
  const liftBR = useLiftClearance(timelineDockEl, cornerBREl);
  const setRangeRef = useRef<
    ((layerId: string, field: string, range: [number, number]) => void) | null
  >(null);
  const onLiveRangeSetter = useCallback(
    (set: (layerId: string, field: string, range: [number, number]) => void) => {
      setRangeRef.current = set;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const failedRead = () => {
      setStatus((s) => (s === "ok" ? s : "error"));
      setFailedReads((n) => n + 1);
    };
    (async () => {
      try {
        const response = await fetch(
          `/api/published/${encodeURIComponent(token)}`,
        );
        if (response.status === 404) {
          if (!cancelled) setStatus("notfound");
          return;
        }
        if (!response.ok) {
          // A refetch that fails must not replace a usable page with the
          // page-level splash: one layer's failure never takes the view
          // down. Once the page reads ok it stays ok — only a load with
          // nothing on screen errors.
          if (!cancelled) failedRead();
          return;
        }
        const data = (await response.json()) as ViewData;
        if (cancelled) return;
        setView(data);
        setStatus("ok");
        if (!timeSeeded.current && data.timeline) {
          timeSeeded.current = true;
          setTimeState({
            window: [
              data.timeline.window.min === null
                ? null
                : timeToMs(data.timeline.window.min),
              data.timeline.window.max === null
                ? null
                : timeToMs(data.timeline.window.max),
            ],
            speed: data.timeline.speed,
          });
        }
        // Frame the data once — a poll refresh must not move the camera.
        // The frame is the EFFECTIVE extent: a published map with a live
        // filter or an initial timeline window would otherwise open
        // framing rows it is not drawing, and only correct itself if the
        // reader happened to press Fit.
        if (!framed.current) {
          const dims: Record<string, LiveDim[]> = {};
          for (const l of data.layers) {
            if (l.liveFilters?.length) dims[l.id] = l.liveFilters;
          }
          if (data.timeline) {
            const t = data.timeline;
            const scrubbed: LiveDim = {
              field: t.field,
              kind: "timerange",
              range: windowToRange([
                t.window.min === null ? null : timeToMs(t.window.min),
                t.window.max === null ? null : timeToMs(t.window.max),
              ]),
            };
            const existing = dims[t.layerId] ?? [];
            const at = existing.findIndex(
              (d) => d.kind === "timerange" && d.field === t.field,
            );
            dims[t.layerId] =
              at === -1
                ? [...existing, scrubbed]
                : existing.map((d, i) => (i === at ? scrubbed : d));
          }
          const local = effectiveExtent(
            readerExtentLayers(data.layers, dims, {}, {}),
          );
          // A tiled layer under a constraint cannot be framed locally; the
          // initial frame uses what the browser can answer rather than
          // waiting on the network before the map appears.
          if (local.bounds) {
            framed.current = true;
            setFitBounds(local.bounds);
          }
        }
      } catch {
        if (!cancelled) failedRead();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, pollTick]);

  // Tiles still preparing when the page loaded: poll (within the published
  // freshness bound) until they settle, then draw.
  const preparing = useMemo(
    () =>
      (view?.layers ?? []).filter(
        (l) => l.render.ok && l.render.tiles?.state === "building",
      ),
    [view],
  );
  // Failed layers are a visible state, never silent absence — every
  // envelope class, inline and tiled alike. The reader sees the
  // documented catalogue prose keyed on the code, never engine text.
  const failedLayers = useMemo(
    () =>
      (view?.layers ?? []).filter((l) => l.visible && !l.render.ok),
    [view],
  );
  useEffect(() => {
    if (status !== "ok" || preparing.length === 0) return;
    const timer = setTimeout(() => setPollTick((t) => t + 1), 5000);
    return () => clearTimeout(timer);
  }, [status, preparing, failedReads]);

  const renderedLayers: RenderedLayer[] = useMemo(
    () =>
      (view?.layers ?? []).map((l) => ({
        id: l.id,
        style: l.style, // already effective — the server resolved the viz fill
        visible: l.visible,
        tooltip: l.tooltip,
        popup: l.popup,
        viz: l.viz,
        geojson: l.render.ok ? l.render.geojson : null,
        tiles:
          l.render.ok &&
          l.render.tiles?.state === "ready" &&
          l.render.tiles.url
            ? {
                url: l.render.tiles.url,
                minZoom: l.render.tiles.minZoom,
                maxZoom: l.render.tiles.maxZoom,
              }
            : null,
      })),
    [view],
  );

  // The viewer's live filtering: each layer's payload carries its
  // resolved dimensions; the docked timeline's dimension follows the
  // viewer's scrub instead of the published settled window. Older cached
  // payloads without the field degrade to just the timeline.
  const canvasFilters: Record<string, LiveDim[]> = useMemo(() => {
    const out: Record<string, LiveDim[]> = {};
    for (const l of view?.layers ?? []) {
      if (l.liveFilters?.length) out[l.id] = l.liveFilters;
    }
    if (view?.timeline && timeState) {
      const t = view.timeline;
      const scrubbed: LiveDim = {
        field: t.field,
        kind: "timerange",
        range: windowToRange(timeState.window),
      };
      const dims = (out[t.layerId] ?? []).slice();
      const idx = dims.findIndex(
        (d) => d.kind === "timerange" && d.field === t.field,
      );
      if (idx === -1) dims.push(scrubbed);
      else dims[idx] = scrubbed;
      out[t.layerId] = dims;
    }
    return out;
  }, [view, timeState]);

  const legendLayers: NamedStyle[] = useMemo(
    () =>
      // A failed layer draws nothing — the legend must not advertise it
      // as drawn. Order is the shared legend decision: the panel's way,
      // or the stored arrangement.
      orderForLegend(
        successfulLegendLayers(view?.layers ?? [], (l) => l.render.ok),
        view?.legendOrder,
      ).map((l) => ({
          name: l.name,
          style: l.style,
          visible: l.visible,
          inLegend: l.inLegend,
          viz: l.viz,
          geometryType: l.render.ok ? (l.render.geometryType ?? null) : null,
          legendTitle: l.legendTitle,
          legendLabels: l.legendLabels,
          legendAttrs: l.legendAttrs,
        })),
    [view],
  );

  // The live dashboard: the same hook and cards as the builder, against the
  // token endpoints. Selections are the reader's session state — the page
  // opens unselected and nothing persists.
  const widgets = useMemo(() => view?.widgets ?? [], [view]);
  const railVisible = widgets.length > 0;
  const legendCorner = view?.legendCorner ?? "bottom-left";
  const legendPlacement = useLegendPlacement(
    legendCorner,
    railVisible,
    widgetStackEl,
    legendCandidateEl,
    `${liftBR}:${timelineDockEl !== null}`,
  );
  const legendDocked = legendPlacement.docked;
  const widgetEndpoints = useMemo(
    () => ({
      values: async (
        selections: WidgetSelection[],
      ): Promise<EndpointResult<WidgetValues>> => {
        try {
          const r = await fetch(
            `/api/published/${encodeURIComponent(token)}/widget-values`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ selections }),
            },
          );
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
          const r = await fetch(
            `/api/published/${encodeURIComponent(token)}/render/${layerId}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ selections: filters }),
            },
          );
          if (!r.ok) return { ok: false, error: await readApiFailure(r) };
          return { ok: true, data: (await r.json()) as LayerRenderData };
        } catch {
          return { ok: false, error: NETWORK_FAILURE };
        }
      },
    }),
    [token],
  );
  const dashboardLayers: DashboardLayer[] = useMemo(
    () =>
      (view?.layers ?? []).map((l) => ({
        id: l.id,
        vizType: l.viz.type,
        liveFiltered: !!(l.render.ok && l.render.liveFiltered),
        // Count the dims actually enforced — the scrubbed timeline can
        // add one beyond the shipped list on older payloads (the budget
        // must see every occupied slot).
        storedDims: (canvasFilters[l.id] ?? l.liveFilters ?? []).length,
      })),
    [view, canvasFilters],
  );
  const dash = useWidgetDashboard({
    widgets,
    layers: dashboardLayers,
    endpoints: widgetEndpoints,
    revision: token,
  });
  // Shipped live filters, the scrubbed timeline, and widget selections
  // share the fixed GPU slots.
  const mergedCanvasFilters = useMemo(() => {
    const out: Record<string, LiveDim[]> = { ...canvasFilters };
    for (const [id, dims] of Object.entries(dash.selectionDims)) {
      out[id] = [...(out[id] ?? []), ...dims].slice(0, LIVE_FILTER_SLOTS);
    }
    return out;
  }, [canvasFilters, dash.selectionDims]);
  // Computed layers draw their settle re-render while selections constrain
  // them; the shipped render returns when selections clear.
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

  if (status === "loading") {
    return (
      <div className={styles.splash}>
        <LogoMark size={30} motion="shimmer" />
        <span className={styles.splashText}>Loading map…</span>
      </div>
    );
  }

  if (status === "notfound") return <PublishedNotFound />;

  if (status === "error" || !view) {
    return (
      <div className={styles.splash}>
        <p className={styles.notfoundText}>The map could not load.</p>
      </div>
    );
  }

  // The legend joins its corner's overlay stack. Top-right docks when
  // widgets are visible; bottom-right remains standalone when its live
  // candidate fits below the widgets-only rail extent.
  const legendBox = (
    <div className={styles.legend}>
      <LegendPanel layers={legendLayers} />
    </div>
  );
  const dockedLegendBox = (
    <div className={styles.legend}>
      <LegendPanel
        layers={legendLayers}
        docked={legendPlacement.width === "rail"}
      />
    </div>
  );
  const bottomRightProbe = legendCorner === "bottom-right" && legendDocked;
  const bottomRightLegendBox = (
    <div
      className={styles.legend}
      ref={setLegendCandidateEl}
      data-legend-placement-probe={bottomRightProbe || undefined}
      aria-hidden={bottomRightProbe || undefined}
      inert={bottomRightProbe || undefined}
      style={bottomRightProbe ? { visibility: "hidden" } : undefined}
    >
      <LegendPanel layers={legendLayers} />
    </div>
  );

  const timeline = view.timeline;

  // The effective theme: the reader's load-local switch, else the
  // authored default. The canvas fallback follows too.
  const authoredTheme = view.theme ?? "dark";
  const effTheme = effectiveViewTheme(authoredTheme);

  // The effective basemap. The reader's pick wins over the authored key;
  // `undefined` means they never touched it.
  const authoredKey = view.basemapKey ?? null;
  // The pick applies exactly as made. The Dark/Light pairing is a move
  // the THEME control makes — see onToggleTheme below — not a rule
  // applied to the current key on every render: deriving it here would
  // make picking Light in dark mode snap straight back to Dark, so one
  // of the two cards could never be chosen at all.
  const themedKey: BasemapKey | null =
    readerBasemap === undefined ? authoredKey : readerBasemap;
  // The authored custom style is the effective basemap until the reader picks a built-in — fixed in
  // both themes, credited from its save-time snapshot. The switch is one-way for the load (decided
  // with eyes open): the custom style is not a picker card, so there is no way back until reload.
  const authoredCustom = view.customBasemap ?? null;
  const customActive = authoredCustom !== null && readerBasemap === undefined;
  const styleUrl = (key: BasemapKey) =>
    basemaps.find((b) => b.key === key)?.url ?? basemapUrl;
  const themedBasemapUrl = customActive
    ? authoredCustom.url
    : themedKey === null
      ? // Auto. A deployment override pins it in both themes; otherwise
        // it follows the effective theme — from the payload's pair when
        // the author was on Auto, and resolved here when they were not
        // (the payload carries no pair in that case).
        view.basemapPinned
        ? basemapUrl
        : (view.basemapForTheme?.[effTheme] ?? styleUrl(effTheme))
      : styleUrl(themedKey);
  // Kind and credit follow the *effective* style, not the authored one.
  // Kind matters beyond looks: the authored content-group toggles apply
  // to vector styles only, and applying a hidden "Land" to imagery would
  // blank the photo. The credit matters because the imagery terms require
  // it wherever the imagery is shown — including when a reader chose it.
  const readerMovedBasemap =
    !customActive && (readerBasemap !== undefined || themedKey !== authoredKey);
  const effBasemapKind = readerMovedBasemap
    ? basemapKindIn(basemaps, themedKey)
    : (view.basemapKind ?? "vector");
  const effAttribution = readerMovedBasemap
    ? basemapCreditIn(basemaps, themedKey)
    : (view.basemapAttribution ?? basemapCreditIn(basemaps, themedKey));

  // Which optional controls this publication exposes. An older cached
  // payload carries none, and every control reads on — the same reading
  // a publication that never stated a set gets.
  const controls = view.viewerControls;
  const showTilt = controls?.tilt !== false;
  const showFit = controls?.fit !== false;
  // An embed keeps the earlier strip. A close sitting
  // accepted that minimal-chrome composition; enabling copy inside a
  // cross-origin iframe would also require a clipboard-write allowance.
  const showCoords = !embedded && controls?.coords !== false;
  // An embed never offers theme or basemap: it sits inside someone
  // else's page, where those choices are the host's.
  const showTheme = !embedded && controls?.theme !== false;
  const showBasemap = !embedded && controls?.basemap !== false;
  const stackTilt = !embedded && showTilt;

  // The theme control moves an unpinned Auto (which follows the theme by
  // definition) and moves the Dark/Light pair with it — those two styles
  // *are* the modes, so leaving them fixed while the chrome flipped read
  // as a bug. Streets and Satellite are choices about content, not mode,
  // and stay put. This supersedes fixed-explicit-basemap rule for those
  // two, on the published viewer only. The pair is taken where the
  // instance offers it, as the switcher lists only offered styles, or
  // where it is the publication's own style, which the map holds even
  // hidden; otherwise the chrome flips and the style stays. A map on its
  // own custom style still carries the key it was on before, but that
  // key is not a style the publication holds: its own style is the
  // custom one, so the stored key opens no way onto a hidden pair.
  const ownKey = authoredCustom === null ? authoredKey : null;
  const onToggleTheme = () => {
    const pair = effTheme === "dark" ? "light" : "dark";
    // A custom style pins both themes: the pairing below must not fire
    // while it is active, or a mere theme toggle would set
    // readerBasemap and silently replace the custom style for the rest
    // of the load.
    if (!customActive && (themedKey === "dark" || themedKey === "light") &&
        (pair === ownKey || offeredOnly(basemaps).some((b) => b.key === pair))) {
      setReaderBasemap(pair);
    }
    toggleViewTheme(authoredTheme);
  };

  // Fit measures what the reader is actually looking at: the timeline
  // window, their widget selections, and the layer filters the canvas
  // enforces. A tiled layer's answer comes from the server, because its
  // features never reach the browser whole; an answer the reader's state
  // has outrun is dropped rather than applied.
  const fitToData = () => {
    const seq = ++fitSeqRef.current;
    void (async () => {
      const live = cameraRef.current?.liveRanges() ?? {};
      const layers = readerExtentLayers(
        view.layers,
        mergedCanvasFilters,
        dash.settleRenders,
        live,
      );
      const local = effectiveExtent(layers);
      let bounds = local.bounds;
      for (const id of local.deferred) {
        const answer = await fetchPublishedExtent(token, id, {
          selections: dash.selections,
          timeline:
            view.timeline && view.timeline.layerId === id && timeState
              ? {
                  min: msToTimeValue(timeState.window[0]),
                  max: msToTimeValue(timeState.window[1]),
                }
              : undefined,
        });
        if (seq !== fitSeqRef.current) return;
        if (!answer.ok) {
          setFitFailure(answer.message);
          return;
        }
        bounds = mergeExtent(bounds, answer.box);
      }
      if (seq !== fitSeqRef.current) return;
      setFitFailure(null);
      // A fresh array every press: the canvas's fit effect keys on
      // reference identity, so handing back the same one would silently do
      // nothing the second time. Nothing drawn leaves the camera alone.
      if (bounds) setFitBounds([...bounds] as Bounds);
    })();
  };

  return (
    <div className={styles.viewer} ref={viewerRootRef}>
      {/* The shared tooltip, scoped to the reader's theme (the Menu
          precedent — a body portal would strand it unthemed). */}
      <HintLayer scope={viewerRootRef} />
      <div className={styles.canvas}>
        <MapCanvas
          basemapUrl={themedBasemapUrl}
          basemapLayers={view.basemapLayers}
          basemapKind={effBasemapKind}
          customBasemap={customActive}
          fallbackColor={BASEMAP_FALLBACKS[effTheme]}
          layers={stagedLayers}
          initialViewport={view.viewport}
          fitBounds={fitBounds}
          liveFilters={mergedCanvasFilters}
          onLiveRangeSetter={onLiveRangeSetter}
          timelineOpen={!!(timeline && timeState)}
          onZoomHandle={(handle) => {
            cameraRef.current = handle;
          }}
          onBearingChange={setBearing}
          onPitchChange={setPitch}
          onStatus={statusChannel.emit}
        />
      </div>

      {/* The live dashboard: read-only reader, live values; the
          overflow menu offers Clear selection only. */}
      {railVisible && (
        <WidgetRail
          widgets={widgets}
          widgetsOnlyRef={setWidgetStackEl}
          values={dash.values}
          valuesState={dash.valuesState}
          audience="reader"
          onRetryValues={dash.retryValues}
          selections={dash.selections}
          onToggleCategory={dash.toggleCategory}
          onBrush={dash.brushRange}
          onClear={dash.clearSelection}
        >
          {legendDocked && dockedLegendBox}
        </WidgetRail>
      )}
      {dash.hint && <div className={widgetStyles.hint}>{dash.hint}</div>}
      <SettleStatus
        states={dash.settleStates}
        layerNames={Object.fromEntries(
          (view?.layers ?? []).map((l) => [l.id, l.name]),
        )}
        audience="reader"
        onRetry={dash.retrySettle}
      />

      {/* The docked timeline: scrub, play, and speed work for the
          viewer; everything stays client-side — read-only page. */}
      {timeline && timeState && (
        <div className={styles.timelineDock} ref={setTimelineDockEl}>
          <TimelineBar
            title={timeline.field}
            extent={[timeToMs(timeline.extent.min), timeToMs(timeline.extent.max)]}
            bins={timeline.bins}
            window={timeState.window}
            speed={timeState.speed}
            onWindow={(win) =>
              setRangeRef.current?.(
                timeline.layerId,
                timeline.field,
                windowToRange(win),
              )
            }
            onSettle={(win) =>
              setTimeState((s) => (s ? { ...s, window: win } : s))
            }
            onSpeed={(speed) =>
              setTimeState((s) => (s ? { ...s, speed } : s))
            }
          />
        </div>
      )}

      <div className={`${styles.corner} ${styles.cornerTopLeft}`}>
        <header className={styles.titleBar}>
          <h1 className={styles.title}>{view.name}</h1>
          {preparing.length > 0 && (
            <span className={styles.preparing}>preparing tiles…</span>
          )}
        </header>
        {fitFailure && (
          <span className={styles.layerFailed} role="alert" data-fit-failed>
            {fitFailure}
          </span>
        )}
        <FailedLayers
          layers={failedLayers.map((l) => ({
            id: l.id,
            name: l.name,
            failure: l.render.ok ? null : (l.render.error ?? null),
          }))}
          onRetry={() => setPollTick((t) => t + 1)}
        />
        {/* The control stack sits under the map's name, which reads as
            its heading, and above a top-left legend — the column stacks
            in DOM order, so there is no overlap and no CSS special case.
            It must stay a direct child: the corner grants pointer events
            to those only. */}
        <StageStack
          cameraRef={cameraRef}
          bearing={bearing}
          pitch={pitch}
          tilt={stackTilt}
        >
          {showFit && (
            <StageButton
              action="Fit to data"
              icon={<FitIcon />}
              onClick={fitToData}
            />
          )}
          {showTheme && (
            <StageButton
              action={
                effTheme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              icon={effTheme === "dark" ? <MoonIcon /> : <SunIcon />}
              aria-pressed={effTheme === "dark"}
              onClick={onToggleTheme}
            />
          )}
          {showBasemap && (
            <BasemapPicker
              active={themedKey}
              custom={customActive}
              pinned={view.basemapPinned ?? false}
              basemaps={basemaps}
              onPick={setReaderBasemap}
            />
          )}
        </StageStack>
        {legendCorner === "top-left" && legendBox}
      </div>

      {!legendDocked && legendCorner === "top-right" && (
        <div className={`${styles.corner} ${styles.cornerTopRight}`}>
          {legendBox}
        </div>
      )}

      <div
        className={`${styles.corner} ${styles.cornerBottomLeft}`}
        ref={setCornerBLEl}
        data-lift={liftBL ? "" : undefined}
      >
        {/* The tilt and theme buttons that used to sit here moved into
            the top-left stack with — one control cluster, in the
            builder's own visual language. */}
        {legendCorner === "bottom-left" && legendBox}
      </div>

      <div
        className={`${styles.corner} ${styles.cornerBottomRight}`}
        ref={setCornerBREl}
        data-lift={liftBR ? "" : undefined}
      >
        {legendCorner === "bottom-right" && bottomRightLegendBox}
        <footer className={styles.attribution}>
          {/* The cursor readout shares the strip: the same ambient-truth
              register as the credit. Off unless the author left "Cursor
              coordinates" on; absent on coarse pointers. */}
          {showCoords && <CursorReadout channel={statusChannel} />}
          {/* Credit follows the effective basemap (the reader's own
              pick) — the imagery terms require their credit wherever
              the imagery is shown. A stale cached payload without the
              field keeps the historical lines. */}
          <BasemapCredit lines={effAttribution} />
          <span className={styles.made}>made with Dezfil</span>
        </footer>
      </div>
    </div>
  );
}

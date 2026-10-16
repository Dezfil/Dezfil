"use client";

import type {
  ComponentProps,
  Dispatch,
  ReactNode,
  Ref,
  SetStateAction,
} from "react";
import dynamic from "next/dynamic";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { Bounds } from "@/lib/geo-bounds";
import type { Corner } from "@/lib/corners";
import type { EffectiveBasemap } from "@/lib/basemap-effective";
import { BASEMAP_FALLBACKS } from "@/lib/basemap";
import type { Theme } from "@/components/theme";
import type { MapCanvas as MapCanvasComponent } from "../map/MapCanvas";
import { BasemapCredit } from "../map/BasemapCredit";
import { LegendPanel, type LegendTextTarget } from "../map/LegendPanel";
import { TimelineBar } from "../map/TimelineBar";
import { WidgetRail } from "../widgets/WidgetRail";
import { SettleStatus } from "../widgets/SettleStatus";
import widgetStyles from "../widgets/Widgets.module.css";
import { BuilderLegendCorners } from "./BuilderLegendCorners";
import { CornerDrag } from "./CornerDrag";
import { StatusBar } from "./StatusBar";
import type { MapPresentationState } from "./use-map-presentation";
import styles from "./MapBuilder.module.css";

const MapCanvas = dynamic(
  () => import("../map/MapCanvas").then((m) => m.MapCanvas),
  { ssr: false, loading: () => <div className={styles.canvasLoading} /> },
);

type CanvasProps = ComponentProps<typeof MapCanvasComponent>;

/** The author's legend: dragged between corners, its text opening the
 * Legend tab, its labels edited in place. Absent, the legend only reads. */
export interface LegendEditing {
  dragPreview: Corner | null;
  onPreview: Dispatch<SetStateAction<Corner | null>>;
  onDrop: (corner: Corner) => void;
  onTextClick: (target: LegendTextTarget) => void;
  onLabelEdit: (layerId: string, slot: number, value: string | null) => void;
}

/** The author's widget card actions: open the editor, delete, reorder. */
export interface WidgetCardActions {
  onOptions: (widgetId: string) => void;
  onDelete: (widgetId: string) => void;
  onReorder: (visibleIds: string[]) => void;
}

/** What authoring hangs on the canvas: drawing's feature pick, viewport
 * persistence, the style panel's label counts and the basemap tab's
 * groups, thumbnail capture, and the camera handle for the draw overlay. */
export interface CanvasAuthoring {
  onFeaturePick?: CanvasProps["onFeaturePick"];
  onViewportChange?: CanvasProps["onViewportChange"];
  onLabelCounts?: CanvasProps["onLabelCounts"];
  onBasemapGroups?: CanvasProps["onBasemapGroups"];
  onSnapshotHandle?: CanvasProps["onSnapshotHandle"];
  onCameraHandle?: CanvasProps["onZoomHandle"];
}

/**
 * The map as the builder shows it, drawn from `useMapPresentation`: the
 * full-viewport map layer with its basemap, and the card over it with the
 * docked timeline, the legend, the widget rail, the settle notes, the
 * basemap credit and the status pill. Out of `MapBuilder.tsx` under the
 * decomposition rule, whole and in the same order, so the builder renders
 * exactly as it did.
 *
 * Mountable on its own with a reader's data: every authoring part is an
 * optional prop (the legend's editing, the widget cards' actions, the
 * canvas's authoring callbacks), and the host's own furniture enters
 * through two slots, `overlay` first over the map and `controls` before
 * the credit, so sibling rules in the stylesheet keep their order, and
 * through `lead`, which heads the top-left corner, above a legend there.
 */
export function MapPresentation({
  stage,
  map,
  basemap,
  theme,
  stageEdges,
  fitBounds,
  timeline,
  audience,
  windowRef,
  overlay,
  controls,
  lead,
  legend,
  widgetActions,
  canvas,
}: {
  stage: MapPresentationState;
  map: MapWithLayers;
  /** The effective basemap: style, kind, credit, custom or not. */
  basemap: EffectiveBasemap;
  /** The canvas fallback colour follows the theme. */
  theme: Theme;
  /** The stage's two edges, the camera's padding and the stage's mark. */
  stageEdges: { left: number; right: number };
  fitBounds: Bounds | null;
  /** The docked timeline's bar, or null when nothing is docked. */
  timeline: ComponentProps<typeof TimelineBar> | null;
  /** Authors keep raw failure detail; readers get the catalogue prose. */
  audience: "author" | "reader";
  /** The map window, the box the host measures as the current view. */
  windowRef?: Ref<HTMLDivElement>;
  overlay?: ReactNode;
  controls?: ReactNode;
  /** The host's notes on the top-left line, above a top-left legend. */
  lead?: ReactNode;
  legend?: LegendEditing;
  widgetActions?: WidgetCardActions;
  canvas?: CanvasAuthoring;
}) {
  // The measured elements' setters, taken out once: they are handed to
  // `ref`, and a ref read off the state object would make the whole
  // object a ref to the compiler.
  const {
    setTimelineDockEl,
    setBottomLeftCornerEl,
    setBottomRightCornerEl,
    setWidgetStackEl,
    setCreditEl,
  } = stage;
  return (
    <>
      {/* The map itself: rendered full-viewport at all times and
          clipped to the card's window, so fullscreen and the dock
          animate the clip — never the canvas size — and no tile
          re-layout can shake the view. The card insets ride along as
          persistent view padding; fullscreen keeps them on purpose, so
          entering it moves not a single map pixel. */}
      <div className={styles.mapLayer} data-map-layer data-stage-edge={`${stageEdges.left}:${stageEdges.right}`}>
        <MapCanvas
          basemapUrl={basemap.url}
          basemapLayers={map.basemapLayers}
          basemapKind={basemap.kind}
          layers={stage.stagedLayers}
          onFeaturePick={canvas?.onFeaturePick}
          initialViewport={map.viewport}
          onViewportChange={canvas?.onViewportChange}
          fitBounds={fitBounds}
          flyTo={stage.flyTo}
          searchMarker={stage.searchMarker}
          onSearchMarkerDismiss={stage.dismissSearchMarker}
          onStatus={stage.statusChannel.emit}
          onLabelCounts={canvas?.onLabelCounts}
          onBasemapGroups={canvas?.onBasemapGroups}
          customBasemap={basemap.custom}
          fallbackColor={BASEMAP_FALLBACKS[theme]}
          liveFilters={stage.canvasDims}
          onLiveRangeSetter={stage.live.onLiveRangeSetter}
          onHeatmapPreviewSetter={stage.onHeatmapPreviewSetter}
          timelineOpen={timeline !== null}
          onZoomHandle={(handle) => {
            stage.onCameraHandle(handle);
            canvas?.onCameraHandle?.(handle);
          }}
          onBearingChange={stage.setBearing}
          onPitchChange={stage.setPitch}
          onSnapshotHandle={canvas?.onSnapshotHandle}
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
        <div className={styles.canvas} data-drag-canvas ref={windowRef}>
          {overlay}
          {/* The docked timeline: bottom-center, over the map, between
              the corner overlays. */}
          {timeline && (
            <div className={styles.timelineDock} ref={setTimelineDockEl}>
              <TimelineBar {...timeline} />
            </div>
          )}
          <BuilderLegendCorners
            legendCorner={stage.legendCorner}
            legendDocked={stage.legendDocked}
            legendLayers={stage.legendLayers}
            dragPreview={legend?.dragPreview ?? null}
            onPreview={legend?.onPreview}
            onDrop={legend?.onDrop}
            onTextClick={legend?.onTextClick}
            onLabelEdit={legend?.onLabelEdit}
            bottomLeftRef={setBottomLeftCornerEl}
            bottomRightRef={setBottomRightCornerEl}
            cornerLift={stage.cornerLift}
            creditLift={stage.creditLift}
            statusPillHidden={stage.statusPillHidden}
            lead={lead}
          />
          {/* The widget rail: the dashboard column on the stage's right
              edge. Cards drag to reorder; each carries a ⋮ menu; a
              right-corner legend docks in and drags back out. */}
          {stage.railVisible && (
            <WidgetRail
              widgets={stage.visibleWidgets}
              widgetsOnlyRef={setWidgetStackEl}
              values={stage.dash.values}
              valuesState={stage.dash.valuesState}
              audience={audience}
              onRetryValues={stage.dash.retryValues}
              selections={stage.dash.selections}
              onToggleCategory={stage.dash.toggleCategory}
              onBrush={stage.dash.brushRange}
              onClear={stage.dash.clearSelection}
              onOptions={widgetActions?.onOptions}
              onDelete={widgetActions?.onDelete}
              onReorder={widgetActions?.onReorder}
            >
              {stage.legendDocked && (
                <div data-no-dnd>
                  {legend ? (
                    <CornerDrag
                      corner={stage.legendCorner}
                      onPreview={legend.onPreview}
                      onDrop={legend.onDrop}
                    >
                      <LegendPanel
                        layers={stage.legendLayers}
                        docked={stage.legendPlacement.width === "rail"}
                        onTextClick={legend.onTextClick}
                        onLabelEdit={legend.onLabelEdit}
                      />
                    </CornerDrag>
                  ) : (
                    <LegendPanel
                      layers={stage.legendLayers}
                      docked={stage.legendPlacement.width === "rail"}
                    />
                  )}
                </div>
              )}
            </WidgetRail>
          )}
          {stage.dash.hint && <div className={widgetStyles.hint}>{stage.dash.hint}</div>}
          <SettleStatus
            states={stage.dash.settleStates}
            layerNames={Object.fromEntries(
              map.layers.map((l) => [l.id, l.name]),
            )}
            audience={audience}
            onRetry={stage.dash.retrySettle}
          />
          {controls}
          {/* The basemap credit, tucked in the map's lower right — out of
              the status pill, which has no room to spare. */}
          <div
            className={styles.mapCredit}
            ref={setCreditEl}
            data-map-credit
            data-lift={stage.creditLift ? "" : undefined}
          >
            <BasemapCredit lines={basemap.attribution} />
          </div>
        </div>
        {/* Status pill: floats bottom-center inside the map card. */}
        {!stage.statusPillHidden && (
          <StatusBar
            channel={stage.statusChannel}
            records={stage.widgetRecords}
            recordsState={stage.dash.valuesState}
            credit={stage.creditEl}
            legend={stage.bottomLeftCornerEl}
            legendRight={stage.bottomRightCornerEl}
          />
        )}
      </div>
    </>
  );
}

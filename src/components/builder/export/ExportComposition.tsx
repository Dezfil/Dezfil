"use client";

import {
  type CSSProperties,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import dynamic from "next/dynamic";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";
import type { AttributionLine, BasemapKind } from "@/lib/basemap";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { WidgetValues } from "@/lib/widget-service";
import type { LiveDim } from "@/lib/live-filters";
import type { ExportImageDefinition } from "@/lib/export/image-definition";
import { pinMarksForSpace } from "@/lib/export/pin-marks";
import {
  REFERENCE_SPACE_WIDTH,
  creditScale,
  elementScale,
} from "@/lib/export/space";
import type { RenderedLayer, Viewport } from "../../map/MapCanvas";
import type { CameraHandle } from "../../map/camera-handle";
import type { CaptureAtSize } from "../../map/capture";
import type { AnswerState } from "../../widgets/dashboard-state";
import {
  LegendPanel,
  legendItems,
  type NamedStyle,
} from "../../map/LegendPanel";
import { useLegendPlacement } from "../../map/use-legend-placement";
import { BasemapCredit } from "../../map/BasemapCredit";
import { WidgetRail } from "../../widgets/WidgetRail";
import styles from "./ExportComposition.module.css";

const MapCanvas = dynamic(
  () => import("../../map/MapCanvas").then((m) => m.MapCanvas),
  { ssr: false },
);

/**
 * The export composition: one component renders what an exported image
 * contains — the map surface, the corner-snapped step-scaled legend, the
 * clipped widget rail, the title chip, the always-burned attribution,
 * and the failure surface — hosted by BOTH the card's preview
 * (interactive, displayed scaled to fit the card) and the bare render
 * route (static, the browser screenshot IS the image).
 *
 * Since the composition is laid out in the space the AUTHOR chose:
 * `width`/`height` are composition pixels, not the preview's on-screen
 * size, and the definition's map scale carries that space to output
 * pixels on either road. Every overlay is scaled in proportion to that
 * space, so its share of the finished image is the same whatever the
 * space, the output width, or the size of the window the card was used
 * in. The attribution
 * alone may leave that rule, and only upward: its legibility floor wins
 * over its share.
 */

const noop = () => {};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export interface CompositionMapInputs {
  basemapUrl: string;
  basemapLayers: BasemapLayers | null;
  basemapKind: BasemapKind;
  /** The style is the map's custom URL — its dead-style
   * wording differs from the offline chip's. */
  customBasemap?: boolean;
  /** Whether the basemap drawn is light or dark: the credit, which has no
   * card of its own, takes this tone's default look. */
  basemapTone: "light" | "dark";
  fallbackColor: string;
  layers: RenderedLayer[];
  liveFilters: Record<string, LiveDim[]> | null;
  camera: Viewport;
}

export function ExportComposition({
  frameRef,
  chromeRef,
  legendScaleRef,
  width,
  height,
  map,
  interactive = false,
  onViewportChange,
  onCaptureHandle,
  onCameraHandle,
  onReadiness,
  onLegendPlacementReadiness,
  onInitialWebGLFailure,
  legend,
  legendLayers,
  outputWidth,
  widgetSize = "m",
  credit,
  widgets,
  values,
  valuesState,
  selections,
  title,
  attribution,
  failures,
  busy,
}: {
  frameRef?: Ref<HTMLDivElement>;
  /** The card's download rasterizes these nodes; the route never needs
   * them. */
  chromeRef?: Ref<HTMLDivElement>;
  legendScaleRef?: Ref<HTMLDivElement>;
  width: number;
  height: number;
  map: CompositionMapInputs;
  interactive?: boolean;
  onViewportChange?: (v: Viewport) => void;
  onCaptureHandle?: (h: CaptureAtSize | null) => void;
  /** The map's imperative camera, so the card can hold the ground when
   * the composition's space changes. The route passes none. */
  onCameraHandle?: (h: CameraHandle | null) => void;
  /** Readiness for the render route; the card passes none. */
  onReadiness?: (ready: boolean) => void;
  /** The render route waits for bottom-right's rAF geometry decision so
   * its screenshot cannot capture the safe-default dock mid-transition. */
  onLegendPlacementReadiness?: (ready: boolean) => void;
  /** Initial MapLibre WebGL failure, kept separate from general readiness. */
  onInitialWebGLFailure?: (message: string) => void;
  legend: ExportImageDefinition["legend"];
  legendLayers: NamedStyle[];
  /** The output's width in pixels — the credit's floor is stated in
   * output pixels, so the composition needs to know what it is composing
   * for. Everything else is a pure function of the space. */
  outputWidth: number;
  /** How large the rail and the attribution are drawn. */
  widgetSize?: ExportImageDefinition["widgetSize"];
  credit?: ExportImageDefinition["credit"];
  widgets: MapWidget[];
  values: WidgetValues | null;
  valuesState: AnswerState;
  selections: WidgetSelection[];
  title: ExportImageDefinition["title"];
  attribution: AttributionLine[];
  /** Truthful failure prose for layers/widgets that could not answer —
   * drawn, never omitted. */
  failures?: string[];
  busy?: boolean;
}) {
  // The author's marks are pinned to their share of the image: the
  // space scales the basemap, never the data. Here, in the one
  // component both roads render, so neither can drift.
  const pinnedLayers = useMemo(
    () => pinMarksForSpace(map.layers, width),
    [map.layers, width],
  );
  // Every overlay's drawn scale comes from the space's short side, so
  // its visual weight is fixed across shapes. `chromeScale` is the
  // middle step: the corner insets and the failure prose ride it,
  // having no step of their own.
  const legendScale = elementScale(width, height, legend.size);
  const chromeScale = elementScale(width, height, "m");
  const railScale = elementScale(width, height, widgetSize);
  const titleScale = elementScale(width, height, title?.size ?? "m");
  const creditCorner = credit?.corner ?? "bottom-right";
  const creditStep = credit?.size ?? "m";
  const legendPresent = legend.visible && legendItems(legendLayers).length > 0;
  const railVisible = widgets.length > 0;
  const [widgetStackEl, setWidgetStackEl] = useState<HTMLElement | null>(null);
  const [legendCandidateEl, setLegendCandidateEl] =
    useState<HTMLElement | null>(null);
  const legendPlacement = useLegendPlacement(
    legend.corner,
    railVisible && legendPresent,
    widgetStackEl,
    legendCandidateEl,
    `${width}:${height}:${widgetSize}:${legend.size}`,
  );
  const legendDocked = legendPresent && legendPlacement.docked;
  const setLegendScaleEl = useCallback(
    (node: HTMLDivElement | null) => {
      setLegendCandidateEl(
        legend.corner === "bottom-right" ? node : null,
      );
      assignRef(legendScaleRef, legendDocked ? null : node);
    },
    [legend.corner, legendDocked, legendScaleRef],
  );
  const placementReady = !legendPresent || legendPlacement.measured;

  useEffect(() => {
    onLegendPlacementReadiness?.(placementReady);
  }, [onLegendPlacementReadiness, placementReady]);

  return (
    <div
      className={styles.frame}
      ref={frameRef}
      style={
        {
          width,
          height,
          "--chrome-scale": chromeScale,
        } as CSSProperties
      }
      data-busy={busy || undefined}
      // The rounded card look is the interactive preview's: a screenshot host renders square, or
      // identical definitions would differ at the corners between hosts.
      data-presentation={interactive || undefined}
      // CornerDrag resolves its quadrants from the closest drag canvas; static hosts carry it
      // harmlessly.
      data-drag-canvas
      data-export-composition=""
      data-legend-placement={
        legendPresent
          ? legendDocked
            ? "docked"
            : "standalone"
          : undefined
      }
    >
      {/* An image keeps Dezfil's default look whatever the person picked:
          the look's default scope puts every token a pick sets back at its
          theme's default, here on everything the frame holds and on the two
          nodes the download rasterizes below, so the preview, the file and
          the render route agree. The frame around it is the card's preview,
          which takes the person's look like the card's other surfaces. */}
      <div className={styles.composition} data-look-default="">
        <MapCanvas
          basemapUrl={map.basemapUrl}
          basemapLayers={map.basemapLayers}
          basemapKind={map.basemapKind}
          customBasemap={map.customBasemap}
          layers={pinnedLayers}
          markScale={width / REFERENCE_SPACE_WIDTH}
          initialViewport={map.camera}
          interactive={interactive}
          onViewportChange={onViewportChange}
          fallbackColor={map.fallbackColor}
          liveFilters={map.liveFilters}
          onCaptureHandle={onCaptureHandle}
          onZoomHandle={onCameraHandle}
          onReadiness={onReadiness}
          onInitialWebGLFailure={onInitialWebGLFailure}
        />
        {/* Overlays are real DOM — the exact nodes the card's download
            rasterizes and the route's screenshot captures. The rail carries
            a docked legend; only a standalone legend leaves this layer. */}
        <div ref={chromeRef} className={styles.chromeLayer} data-look-default="">
          {widgets.length > 0 && (
            <div inert className={styles.railHost}>
              <div
                className={styles.railScale}
                style={{ "--rail-scale": railScale } as CSSProperties}
              >
                <WidgetRail
                  widgets={widgets}
                  widgetsOnlyRef={setWidgetStackEl}
                  values={values}
                  valuesState={valuesState}
                  selections={selections}
                  onToggleCategory={noop}
                  onBrush={noop}
                >
                  {legendDocked && (
                    <div data-export-docked-legend>
                      <LegendPanel
                        layers={legendLayers}
                        docked={legendPlacement.width === "rail"}
                      />
                    </div>
                  )}
                </WidgetRail>
              </div>
            </div>
          )}
          {title && (
            <div
              className={styles.titleChip}
              style={{ "--title-scale": titleScale } as CSSProperties}
            >
              {title.text}
            </div>
          )}
          {/* Attribution is always burned in (D4): plain small text on
              the map, no card, with the quiet mark. It takes a corner and
              a step — and a floor, which is the one place an element
              leaves the share rule, and only upward. Having no card, it
              takes the default look of the basemap's tone rather than the
              image's theme, so it reads against the map it sits on. */}
          <div data-look-default={map.basemapTone}>
            <div
              className={styles.credit}
              data-corner={creditCorner}
              style={
                {
                  "--credit-scale": creditScale(
                    width,
                    height,
                    creditStep,
                    outputWidth,
                  ),
                } as CSSProperties
              }
            >
              <BasemapCredit lines={attribution} />
              <span className={styles.creditDot}>·</span>
              <span className={styles.creditMark}>Made with Dezfil</span>
            </div>
          </div>
          {failures && failures.length > 0 && (
            <div className={styles.failures} role="note">
              {failures.map((f) => (
                <p key={f}>{f}</p>
              ))}
            </div>
          )}
        </div>
        {/* The legend sits where the builder put it:
            the in-preview corner drag retired — position is decided in the
            builder, not at export time. */}
        {legendPresent &&
          (!legendDocked || legend.corner === "bottom-right") && (
          <div
            className={styles.legendCorner}
            data-corner={legend.corner}
            data-legend-placement-probe={legendDocked || undefined}
            aria-hidden={legendDocked || undefined}
            inert={legendDocked || undefined}
            style={legendDocked ? { visibility: "hidden" } : undefined}
          >
            <div
              ref={setLegendScaleEl}
              className={styles.legendScale}
              data-look-default=""
              style={{ "--legend-scale": legendScale } as CSSProperties}
              data-corner={legend.corner}
            >
              <LegendPanel layers={legendLayers} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { CORNERS, type Corner } from "@/lib/corners";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";
import type { AttributionLine, BasemapKind } from "@/lib/basemap";
import type { BasemapLayers } from "@/lib/basemap-layers";
import type { WidgetValues } from "@/lib/widget-service";
import type { LiveDim } from "@/lib/live-filters";
import {
  EXPORT_MAX_DIMENSION,
  EXPORT_WIDTH_PRESETS,
  initialDefinition,
  type Appearance,
  type ExportImageDefinition,
  type SizeStep,
} from "@/lib/export/image-definition";
import {
  SIZE_STEPS_BY_SPACE,
  chooseSize,
  legalStepFor,
  resolveSpace,
  stepChangeZoom,
  stepUnavailable,
  widthChangeZoom,
} from "@/lib/export/space";
import type { RenderedLayer, Viewport } from "../../map/MapCanvas";
import type { CameraHandle } from "../../map/camera-handle";
import type { CaptureAtSize } from "../../map/capture";
import type { AnswerState } from "../../widgets/dashboard-state";
import { legendItems, type NamedStyle } from "../../map/LegendPanel";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { ErrorNote } from "../../ui/ErrorNote";
import { ExportComposition } from "./ExportComposition";
import { buildCompositionMapInputs } from "./composition-map-inputs";
import { ExportOptionsRail } from "./ExportOptionsRail";
import { FrameSash } from "./FrameSash";
import {
  aspectName,
  aspectRatio,
  snapAspect,
  type AspectKey,
  type ShapeMode,
} from "./aspect";
import { composeAndDownload } from "./download";
import styles from "./ExportImageCard.module.css";

/**
 * The export image card: a large modal with a live map preview left and
 * an options rail right. The preview is a real map seeded from the
 * builder's camera and framed independently — panning and zooming happen
 * inside it and the builder's viewport never moves.
 *
 * Since the preview lays its composition out in the **space the author
 * chose** — the map-size step — and is displayed scaled to fit the card.
 * That is what decouples how large the map is drawn from how large the
 * card's window happens to be, and it is why nothing here measures an
 * on-screen rectangle to decide a scale: the space and the output are
 * both known numbers, and the display factor is presentation only.
 */

/** Everything the card reads from the builder — computed state the
 * builder's own canvas already consumes, so the preview cannot diverge. */
export interface ExportStage {
  map: MapWithLayers;
  /** The builder's active theme — captured into the definition. */
  appearance: Appearance;
  layers: RenderedLayer[];
  basemapUrl: string;
  basemapLayers: BasemapLayers | null;
  basemapKind: BasemapKind;
  fallbackColor: string;
  liveFilters: Record<string, LiveDim[]> | null;
  camera: Viewport;
  /** The builder canvas's CSS width at open, so the card can open on the
   * ground the author is looking at rather than the same zoom number in
   * a different space. */
  canvasWidth: number;
  /** The legal opening step chosen from the same live snapshot as the
   * camera and canvas width, judged at the opening size's shape. */
  mapStep: SizeStep;
  /** The output size the card opens at: the instance's starting width
   * and shape when it opened. */
  openingSize: { width: number; height: number };
  legendLayers: NamedStyle[];
  widgets: MapWidget[];
  values: WidgetValues | null;
  valuesState: AnswerState;
  selections: WidgetSelection[];
  attribution: AttributionLine[];
}

const noop = () => {};

export function ExportImageCard({
  stage,
  onClose,
}: {
  stage: ExportStage;
  onClose: () => void;
}) {
  // Legend presence is the panel's own contribution rule, not a layer
  // count — a map whose layers all opt out opens with the toggle off.
  const legendPresent = legendItems(stage.legendLayers).length > 0;

  // The opening step: S, or the first coarser step the engine can
  // actually draw from here — compensating for a wider space raises the
  // zoom, and a builder near the ceiling would be silently clamped.
  const [mapStep, setMapStep] = useState<SizeStep>(stage.mapStep);

  // The definition is the card's one source of truth — the editor for
  // the public contract. Seeded once, at the size the card opened at, in
  // the space it will open in.
  const [def, setDef] = useState<ExportImageDefinition>(() =>
    initialDefinition(
      {
        appearance: stage.appearance,
        camera: stage.camera,
        canvasWidth: stage.canvasWidth,
        legendPresent,
        legendCorner: stage.map.legendCorner,
        visibleWidgetIds: stage.widgets.filter((w) => w.visible).map((w) => w.id),
        basemapLayers: stage.basemapLayers,
      },
      // The opening space, through the same resolver every other host
      // uses, so a fresh card and its first render cannot disagree.
      (() => {
        const fit = resolveSpace(stage.openingSize, stage.mapStep);
        return { width: fit.width, scale: fit.scale };
      })(),
      stage.openingSize,
    ),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialWebGLFailure, setInitialWebGLFailure] = useState<string | null>(
    null,
  );

  // The camera the preview MOUNTS with must be the definition's, not the
  // builder's: the seed compensates the zoom for the card's wider space,
  // and MapCanvas consumes its initial viewport once. Mounting with the
  // builder's camera framed more ground than the same definition renders
  // on the server — the framing parity established.
  const [mountCamera] = useState<Viewport>(() => def.viewport);

  const captureRef = useRef<CaptureAtSize | null>(null);
  const cameraRef = useRef<CameraHandle | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const legendScaleRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);

  // ---- geometry: the authored space, and how it is displayed ----
  const ratio = def.size.width / def.size.height;
  // One resolution, shared with both export roads: the step's nominal
  // width for this shape, nudged to the nearest that lays the output
  // out whole, and the height the roads themselves derive. Resolving it
  // here a second way is what let the preview draw overlays a different
  // size from the file.
  const resolved = useMemo(() => resolveSpace(def.size, mapStep), [
    def.size,
    mapStep,
  ]);
  const space = useMemo(
    () => ({ w: resolved.width, h: Math.max(1, resolved.height) }),
    [resolved],
  );
  const mapScale = resolved.scale;

  /** Every size change lands on one the composition can lay out whole. Applied where the size is SET rather than watched by
   * an effect, so the definition is never briefly a size the card would
   * not have offered.
   *
   * Camera compensation splits by cause. A width change at the same
   * shape compensates between the actual snapped spaces — output width
   * is only meant to sharpen the same picture. A shape
   * change leaves the camera untouched: under short-side anchoring that
   * is what holds the short-axis ground scale while the long axis gains
   * or loses coverage, and it keeps a sash drag from walking the zoom
   * toward the ceiling. */
  const sized = useCallback(
    (
      d: ExportImageDefinition,
      size: { width: number; height: number },
      step: SizeStep,
      holdGround: boolean,
    ): ExportImageDefinition => {
      // Choosing the SIZE may move the height a pixel or two on an
      // awkward custom shape, so the step stays recognisably itself;
      // resolving the space from that chosen size is a separate job,
      // and one function does each everywhere.
      const next = chooseSize(size);
      if (!holdGround) {
        return { ...d, size: next };
      }
      const zoom = widthChangeZoom(d.size, next, step, d.viewport.zoom);
      if (zoom !== d.viewport.zoom) cameraRef.current?.setZoom(zoom);
      return {
        ...d,
        size: next,
        viewport: { ...d.viewport, zoom },
      };
    },
    [],
  );

  const stageBoxRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = stageBoxRef.current;
    if (!el) return;
    const measure = () => setAvail({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Presentation only: the largest uniform scale that fits the stage,
   * up as well as down — a coarse space no longer shrinks the on-screen
   * frame, it is just drawn softer. It never reaches the definition,
   * and nothing measured through it decides an output size. */
  const display = useMemo(() => {
    if (!avail) return null;
    return Math.min((avail.w - 2) / space.w, (avail.h - 2) / space.h);
  }, [avail, space.w, space.h]);

  const effectiveDef = useMemo<ExportImageDefinition>(
    () => ({ ...def, mapScale }),
    [def, mapScale],
  );

  // ---- the map-size step: change the space, hold the ground ----
  const mapStepReasons = useMemo(() => {
    const reasons: Partial<Record<SizeStep, string>> = {};
    for (const step of SIZE_STEPS_BY_SPACE) {
      const why = stepUnavailable(step, def.size, def.viewport.zoom, space.w);
      if (why) reasons[step] = why;
    }
    return reasons;
  }, [def.size, def.viewport.zoom, space.w]);

  const changeMapStep = useCallback(
    (next: SizeStep) => {
      // The delta is between the ACTUAL spaces, not the nominal ones: a
      // space is snapped to divide the output, so using the nominal
      // number moved the ground by several percent.
      // Both sides come from the one resolver the render itself uses —
      // compensating against a space the render then does not use is
      // what moved the ground by up to two zoom levels on a custom
      // shape. The output size never moves for a
      // step: a step is not a resize.
      const zoom = stepChangeZoom(
        def.size,
        mapStep,
        next,
        def.viewport.zoom,
      );
      cameraRef.current?.setZoom(zoom);
      setDef((d) => ({ ...d, viewport: { ...d.viewport, zoom } }));
      setMapStep(next);
    },
    [def.size, def.viewport.zoom, mapStep],
  );

  /** Land a new size, keeping the SELECTED step offerable.
   *
   * A step's space grows with the shape, so a wide enough shape pushes
   * a fine step past the working canvas — and a selection left there
   * mints a definition the render route and the export API refuse
   * while the browser road still writes a file.
   * `stepUnavailable` only ever disabled steps the author had not
   * chosen; this is what moves the one they had.
   *
   * Both size paths pass through here, not just the shape one: a width
   * change keeps the shape only approximately — the chosen height may
   * move a few pixels — and that is enough to flip a step's legality.
   * Degrading is itself a step
   * change, so the ground is held across it.
   */
  const commit = useCallback(
    (next: ExportImageDefinition) => {
      const step = legalStepFor(
        mapStep,
        next.size,
        next.viewport.zoom,
        resolveSpace(next.size, mapStep).width,
      );
      if (step === mapStep) {
        setDef(next);
        return;
      }
      const zoom = stepChangeZoom(next.size, mapStep, step, next.viewport.zoom);
      cameraRef.current?.setZoom(zoom);
      setDef({ ...next, viewport: { ...next.viewport, zoom } });
      setMapStep(step);
    },
    [mapStep],
  );

  // ---- shape ----
  const applyRatio = useCallback(
    (next: number) => {
      // A shape that would push the height past the ceiling steps the
      // width down instead of minting an invalid definition.
      // Step down through the OFFERED presets: an invented width leaves
      // no size chip selected and no stated reason.
      let width = def.size.width;
      while (Math.round(width / next) > EXPORT_MAX_DIMENSION) {
        const smaller = [...EXPORT_WIDTH_PRESETS]
          .reverse()
          .find((w) => w < width);
        if (!smaller) break;
        width = smaller;
      }
      // A shape change: the camera stays put.
      const shaped = sized(
        def,
        {
          width,
          height: Math.min(
            EXPORT_MAX_DIMENSION,
            Math.max(64, Math.round(width / next)),
          ),
        },
        mapStep,
        false,
      );
      commit(shaped);
    },
    [def, mapStep, sized, commit],
  );

  const onWidth = useCallback(
    (width: number) => {
      commit(
        sized(
          def,
          {
            width,
            height: Math.max(
              64,
              Math.round(width * (def.size.height / def.size.width)),
            ),
          },
          mapStep,
          // The same shape, sharper: the ground holds.
          true,
        ),
      );
    },
    [def, mapStep, sized, commit],
  );

  // Custom is sticky (field round, directive 2): choosing it is a mode,
  // so the card stays on Custom while the author works the sash even
  // when the ratio momentarily equals a preset. A preset click or a
  // drag that SNAPS to a preset ends the mode — that is what snapping
  // means.
  const [shapeMode, setShapeMode] = useState<ShapeMode>("preset");
  const onAspect = useCallback(
    (key: AspectKey | "custom") => {
      if (key === "custom") {
        setShapeMode("custom");
        return;
      }
      setShapeMode("preset");
      applyRatio(aspectRatio(key));
    },
    [applyRatio],
  );

  const activeAspect =
    shapeMode === "custom" ? "custom" : (snapAspect(ratio) ?? "custom");
  const shapeLabel = aspectName(ratio);

  /** Snapping is settled on release, from the ratio the drag ended on.
   * Landing on a preset hands the selection to that preset's card and
   * ends the custom mode — that is what snapping means. Shared by both
   * sashes: which edge moved does not change what a release decides. */
  const onSashEnd = useCallback(
    (ratio: number | null) => {
      const snappedKey = ratio === null ? null : snapAspect(ratio);
      if (snappedKey) {
        applyRatio(aspectRatio(snappedKey));
        setShapeMode("preset");
      }
    },
    [applyRatio],
  );

  // ---- preview camera ----
  const onPreviewViewport = useCallback((v: Viewport) => {
    setDef((d) => ({
      ...d,
      viewport: {
        lng: v.lng,
        lat: v.lat,
        zoom: v.zoom,
        pitch: v.pitch ?? 0,
        bearing: v.bearing ?? 0,
      },
    }));
  }, []);

  const shownWidgets = useMemo(
    () => stage.widgets.filter((w) => def.widgets.includes(w.id)),
    [stage.widgets, def.widgets],
  );

  const legendVisible = def.legend.visible && legendPresent;

  /** The legend and the credit never share a corner. The credit control
   * refuses the legend's corner, but the legend can be DRAGGED onto the
   * credit's — and a map whose saved legend corner is bottom-right opens
   * with both there. So the rule lives here, where every
   * corner change passes, and the credit is the one that gives way: the
   * author just chose where the legend goes. */
  const moveLegend = useCallback(
    (d: ExportImageDefinition, corner: Corner): ExportImageDefinition => {
      const credit = d.credit ?? { corner: "bottom-right" as Corner, size: "m" as SizeStep };
      const next =
        credit.corner === corner
          ? {
              ...credit,
              corner:
                CORNERS.find((c) => c !== corner && c !== d.legend.corner) ??
                credit.corner,
            }
          : credit;
      return { ...d, legend: { ...d.legend, corner }, credit: next };
    },
    [],
  );

  const download = useCallback(async () => {
    const capture = captureRef.current;
    const frame = frameRef.current;
    if (busy) return;
    if (initialWebGLFailure) {
      setError(initialWebGLFailure);
      return;
    }
    if (!capture || !frame) {
      setError("The preview is not ready yet. Give it a moment, then retry.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const standaloneLegend = legendScaleRef.current;
      await composeAndDownload({
        capture,
        definition: effectiveDef,
        mapName: stage.map.name,
        legend: legendVisible && standaloneLegend
          ? { node: standaloneLegend, corner: effectiveDef.legend.corner }
          : null,
        chrome: chromeRef.current,
      });
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "The image could not be produced.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, effectiveDef, initialWebGLFailure, legendVisible, stage.map.name]);

  return (
    <Dialog
      label="Export image"
      onClose={busy ? noop : onClose}
      className={styles.dialog}
      data-export-card=""
    >
      <div className={styles.body}>
        <div className={styles.previewCol}>
          <div className={styles.stage} ref={stageBoxRef}>
            {display !== null && (
              <div
                className={styles.frameBox}
                data-custom={shapeMode === "custom" || undefined}
                style={{
                  width: Math.max(40, Math.round(space.w * display)),
                  height: Math.max(30, Math.round(space.h * display)),
                }}
              >
                <div
                  className={styles.frameScale}
                  style={{
                    width: space.w,
                    height: space.h,
                    transform: `scale(${display})`,
                  }}
                >
                  <ExportComposition
                    frameRef={frameRef}
                    chromeRef={chromeRef}
                    legendScaleRef={legendScaleRef}
                    width={space.w}
                    height={space.h}
                    outputWidth={def.size.width}
                    interactive
                    busy={busy}
                    map={buildCompositionMapInputs({
                      definitionBasemapLayers: def.basemapLayers,
                      storedBasemapLayers: stage.basemapLayers,
                      basemapKey: stage.map.basemap,
                      appearance: stage.appearance,
                      basemapUrl: stage.basemapUrl,
                      basemapKind: stage.basemapKind,
                      customBasemap: stage.map.customBasemap !== null,
                      fallbackColor: stage.fallbackColor,
                      layers: stage.layers,
                      liveFilters: stage.liveFilters,
                      camera: mountCamera,
                    })}
                    onViewportChange={onPreviewViewport}
                    onCaptureHandle={(h) => {
                      captureRef.current = h;
                    }}
                    onCameraHandle={(h) => {
                      cameraRef.current = h;
                    }}
                    onInitialWebGLFailure={(message) => {
                      captureRef.current = null;
                      setInitialWebGLFailure(message);
                    }}
                    legend={{ ...def.legend, visible: legendVisible }}
                    legendLayers={stage.legendLayers}
                    widgets={shownWidgets}
                    widgetSize={def.widgetSize}
                    credit={def.credit}
                    values={stage.values}
                    valuesState={stage.valuesState}
                    selections={stage.selections}
                    title={def.title}
                    attribution={stage.attribution}
                  />
                </div>
                {shapeMode === "custom" && (
                  <>
                    <FrameSash
                      edge="bottom"
                      onRatio={applyRatio}
                      onEnd={onSashEnd}
                    />
                    <FrameSash
                      edge="right"
                      onRatio={applyRatio}
                      onEnd={onSashEnd}
                    />
                  </>
                )}
              </div>
            )}
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaOut}>
              output {def.size.width} × {def.size.height} px
              {display !== null &&
                ` · preview at ${Math.round((display / mapScale) * 100)}%`}
            </span>
            <span className={styles.metaHint}>
              drag the map to reframe · scroll to zoom
            </span>
          </div>
        </div>

        <div className={styles.rail}>
          <ExportOptionsRail
            def={def}
            setDef={setDef}
            aspect={activeAspect}
            onAspect={onAspect}
            onWidth={onWidth}
            onLegendCorner={moveLegend}
            aspectLabel={shapeLabel}
            mapStep={mapStep}
            onMapStep={changeMapStep}
            mapStepReasons={mapStepReasons}
            legendPresent={legendPresent}
            widgets={stage.widgets}
            basemapKind={stage.basemapKind}
          />

          <div className={styles.railFoot}>
            <p className={styles.footNote}>PNG · attribution included</p>
            {error && (
              <ErrorNote message={error} onRetry={() => void download()} />
            )}
            <div className={styles.btnRow}>
              <Button variant="quiet" onClick={onClose} disabled={busy}>
                Close
              </Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => void download()}
                data-export-download=""
              >
                {busy ? "Preparing image…" : "Download PNG"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

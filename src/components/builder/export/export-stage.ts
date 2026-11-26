import type { MapWithLayers } from "@/lib/metadata/maps";
import { BASEMAP_FALLBACKS } from "@/lib/basemap";
import type { EffectiveBasemap } from "@/lib/basemap-effective";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";
import type { AttributionLine, BasemapKind } from "@/lib/basemap";
import type { WidgetValues } from "@/lib/widget-service";
import type { LiveDim } from "@/lib/live-filters";
import type { Appearance } from "@/lib/export/image-definition";
import type { LabelTone } from "@/lib/style/label-recipe";
import type { RenderedLayer } from "../../map/MapCanvas";
import type { NamedStyle } from "../../map/LegendPanel";
import type { AnswerState } from "../../widgets/dashboard-state";
import type { ExportSeed } from "./use-export-card";
import type { ExportStage } from "./ExportImageCard";
import type { MapPresentationState } from "../use-map-presentation";

/**
 * What the export card is handed: the builder's own computed drawing
 * state, gathered in one place so the card cannot diverge from the
 * canvas — and so the builder carries a call rather than a twenty-line
 * object literal. The decomposition rule's at-touch slice for this
 * feature.
 *
 * Everything here is already-computed state the builder's canvas
 * consumes; nothing is derived a second time.
 */
export function buildExportStage(input: {
  map: MapWithLayers;
  appearance: Appearance;
  layers: RenderedLayer[];
  basemapUrl: string;
  basemapKind: BasemapKind;
  labelTone: LabelTone;
  fallbackColor: string;
  liveFilters: Record<string, LiveDim[]> | null;
  seed: ExportSeed;
  legendLayers: NamedStyle[];
  widgets: MapWidget[];
  values: WidgetValues | null;
  valuesState: AnswerState;
  selections: WidgetSelection[];
  attribution: AttributionLine[];
}): ExportStage {
  return {
    map: input.map,
    appearance: input.appearance,
    layers: input.layers,
    basemapUrl: input.basemapUrl,
    basemapLayers: input.map.basemapLayers,
    basemapKind: input.basemapKind,
    labelTone: input.labelTone,
    fallbackColor: input.fallbackColor,
    liveFilters: input.liveFilters,
    camera: input.seed.camera,
    canvasWidth: input.seed.canvasWidth,
    mapStep: input.seed.mapStep,
    openingSize: input.seed.size,
    legendLayers: input.legendLayers,
    widgets: input.widgets,
    values: input.values,
    valuesState: input.valuesState,
    selections: input.selections,
    attribution: input.attribution,
  };
}

/**
 * The builder's export stage from its own surfaces, out of the builder under
 * the decomposition rule: the map presentation its canvas draws and the
 * effective basemap under it, in the builder's theme, so the card draws the
 * layers, the basemap and the labels' tone the canvas does.
 */
export function builderExportStage(input: {
  map: MapWithLayers;
  theme: Appearance;
  basemap: Pick<EffectiveBasemap, "url" | "kind" | "attribution" | "labelTone">;
  presentation: Pick<MapPresentationState, "stagedLayers" | "canvasDims" | "legendLayers" | "resolvableWidgets" | "dash">;
  seed: ExportSeed;
}): ExportStage {
  const { map, theme, basemap, presentation, seed } = input;
  return buildExportStage({
    map,
    appearance: theme,
    layers: presentation.stagedLayers,
    basemapUrl: basemap.url,
    basemapKind: basemap.kind,
    labelTone: basemap.labelTone,
    fallbackColor: BASEMAP_FALLBACKS[theme],
    liveFilters: presentation.canvasDims,
    seed,
    legendLayers: presentation.legendLayers,
    widgets: presentation.resolvableWidgets,
    values: presentation.dash.values,
    valuesState: presentation.dash.valuesState,
    selections: presentation.dash.selections,
    attribution: basemap.attribution,
  });
}

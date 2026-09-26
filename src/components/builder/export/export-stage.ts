import type { MapWithLayers } from "@/lib/metadata/maps";
import type { MapWidget, WidgetSelection } from "@/lib/widgets";
import type { AttributionLine, BasemapKind } from "@/lib/basemap";
import type { WidgetValues } from "@/lib/widget-service";
import type { LiveDim } from "@/lib/live-filters";
import type { Appearance } from "@/lib/export/image-definition";
import type { RenderedLayer } from "../../map/MapCanvas";
import type { NamedStyle } from "../../map/LegendPanel";
import type { AnswerState } from "../../widgets/dashboard-state";
import type { ExportSeed } from "./use-export-card";
import type { ExportStage } from "./ExportImageCard";

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
    fallbackColor: input.fallbackColor,
    liveFilters: input.liveFilters,
    camera: input.seed.camera,
    canvasWidth: input.seed.canvasWidth,
    mapStep: input.seed.mapStep,
    legendLayers: input.legendLayers,
    widgets: input.widgets,
    values: input.values,
    valuesState: input.valuesState,
    selections: input.selections,
    attribution: input.attribution,
  };
}

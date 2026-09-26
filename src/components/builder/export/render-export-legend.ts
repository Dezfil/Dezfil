import type { Layer } from "@/lib/metadata/maps";
import type { LayerRenderData } from "@/lib/layer-service";
import { effectiveStyle } from "@/lib/viz";
import {
  orderForLegend,
  successfulLegendLayers,
} from "@/lib/style/legend-order";
import type { NamedStyle } from "@/components/map/LegendPanel";

type ExportLegendRender =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ok"; value: LayerRenderData };

/** Legend rows for the server export composition. A layer must have a
 * successful render before ordering and styling can make it into the image. */
export function renderExportLegendLayers(
  layers: readonly Layer[],
  legendOrder: readonly string[] | null | undefined,
  renders: Readonly<Record<string, ExportLegendRender | undefined>>,
): NamedStyle[] {
  const successful = successfulLegendLayers(layers, (layer) => {
    const fetched = renders[layer.id];
    return fetched?.state === "ok" && fetched.value.ok;
  });

  return orderForLegend(successful, legendOrder).map((layer) => {
    const fetched = renders[layer.id];
    const render =
      fetched?.state === "ok" && fetched.value.ok ? fetched.value : null;
    return {
      id: layer.id,
      name: layer.name,
      style: effectiveStyle(layer.style, layer.viz),
      visible: layer.visible,
      inLegend: layer.inLegend,
      viz: layer.viz,
      geometryType: render ? (render.geometryType ?? null) : null,
      legendTitle: layer.legendTitle,
      legendLabels: layer.legendLabels,
      legendAttrs: layer.legendAttrs,
    };
  });
}

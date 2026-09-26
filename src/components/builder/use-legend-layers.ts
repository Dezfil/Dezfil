"use client";

import { useMemo } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { LayerRenderData } from "@/lib/layer-service";
import { effectiveStyle } from "@/lib/viz";
import { orderForLegend } from "@/lib/style/legend-order";
import type { NamedStyle } from "../map/LegendPanel";
import type { LegendLiveText } from "./LegendTab";
import type { AppearanceDraft } from "./builder-shell-state";

/**
 * The builder's legend inputs, out of `MapBuilder.tsx` (at-touch
 * decomposition slice): the same assembly the builder always made —
 * live text overrides and appearance drafts folded over the stored
 * layers — now carrying each layer's rendered geometry, which the
 * constant-row swatch needs to tell stroke from fill.
 */
export function useLegendLayers({
  map,
  renders,
  legendLive,
  appearanceDrafts,
}: {
  map: MapWithLayers | null;
  renders: Record<string, LayerRenderData | undefined>;
  legendLive: Record<string, LegendLiveText>;
  appearanceDrafts: Record<string, AppearanceDraft>;
}): NamedStyle[] {
  return useMemo(
    () =>
      // Legend order: the panel's way by default, the stored arrangement
      // when the map has one.
      orderForLegend(map?.layers ?? [], map?.legendOrder).map((l) => {
        const live = legendLive[l.id];
        const appearance = appearanceDrafts[l.id];
        const viz = appearance?.viz ?? l.viz;
        const render = renders[l.id];
        return {
          id: l.id,
          name: l.name,
          style: effectiveStyle(appearance?.style ?? l.style, viz),
          visible: l.visible,
          inLegend: l.inLegend,
          viz,
          geometryType: render?.ok ? (render.geometryType ?? null) : null,
          legendTitle:
            live?.legendTitle !== undefined ? live.legendTitle : l.legendTitle,
          legendLabels:
            live?.legendLabels !== undefined
              ? live.legendLabels
              : l.legendLabels,
          legendAttrs:
            live?.legendAttrs !== undefined ? live.legendAttrs : l.legendAttrs,
        };
      }),
    [map, renders, legendLive, appearanceDrafts],
  );
}

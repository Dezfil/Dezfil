"use client";

import { useMemo } from "react";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { MapWidget } from "@/lib/widgets";

/**
 * The builder's widget cuts (split export card, the decomposition
 * habit's at-touch slice): **resolvable** = the widget's layer still
 * exists (notes carry none); **visible** additionally requires the
 * stored flag. The rail renders the visible set; the export card offers
 * every resolvable widget with visibility as the default. A live
 * widget-editor preview substitutes into either cut.
 */
export function useBuilderWidgets(
  map: MapWithLayers | null,
  widgetPreview: MapWidget | null,
): { resolvableWidgets: MapWidget[]; visibleWidgets: MapWidget[] } {
  const resolvableWidgets = useMemo(() => {
    const stored = map?.widgets ?? [];
    const effective = widgetPreview
      ? stored.some((w) => w.id === widgetPreview.id)
        ? stored.map((w) => (w.id === widgetPreview.id ? widgetPreview : w))
        : [...stored, widgetPreview]
      : stored;
    return effective.filter(
      (w) =>
        w.layerId === null ||
        (map?.layers ?? []).some((l) => l.id === w.layerId),
    );
  }, [map, widgetPreview]);
  const visibleWidgets = useMemo(
    () => resolvableWidgets.filter((w) => w.visible),
    [resolvableWidgets],
  );
  return { resolvableWidgets, visibleWidgets };
}

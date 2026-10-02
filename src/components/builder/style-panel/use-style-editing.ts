"use client";

import { useCallback } from "react";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import type { FieldStats } from "@/lib/layer-service";
import {
  defaultViz, isAggregated, isOdViz, ELEVATION_HEIGHT,
  type Aggregate, type AggregatedViz, type CellElevation, type LayerViz, type OdViz,
} from "@/lib/viz";
import { inferOd, odCandidates, type OdEndpoint } from "@/lib/od";
import { renderGeometryKind } from "../render-data";
import type { StylePanelProps } from "../StylePanel";
import { useStyleChannels } from "./use-style-channels";
import { useLabelSetters } from "./use-label-setters";
import { useLayerFields } from "./use-layer-fields";

/** Stable select value for an endpoint, independent of object key order. */
export function endpointKey(endpoint: OdEndpoint | null): string {
  if (endpoint === null) return "";
  return endpoint.kind === "geometry"
    ? JSON.stringify(["g", endpoint.field])
    : JSON.stringify(["p", endpoint.lon, endpoint.lat]);
}

export function endpointFromKey(key: string): OdEndpoint | null {
  if (!key) return null;
  const parts = JSON.parse(key) as string[];
  return parts[0] === "g"
    ? { kind: "geometry", field: parts[1] }
    : { kind: "lonlat", lon: parts[1], lat: parts[2] };
}

export function endpointLabel(endpoint: OdEndpoint): string {
  return endpoint.kind === "geometry"
    ? endpoint.field
    : `${endpoint.lon} + ${endpoint.lat}`;
}

/** Translate controls into style edits, live previews and released commits. */
export function useStyleEditing({
  layer, render, onStyle, onStylePreview, onStyleCommit, onViz, onAggregatedFillPreview, onAggregatedFillCommit, onAggregationPreview, onAggregationCommit,
}: Pick<StylePanelProps, "layer" | "render" | "onStyle" | "onStylePreview" | "onStyleCommit" | "onViz" | "onAggregatedFillPreview" | "onAggregatedFillCommit" | "onAggregationPreview" | "onAggregationCommit">) {
  const fields = useLayerFields(layer);
  const { busy, channelError, dismissChannelError, classify, resolveScale } =
    useStyleChannels(layer.id);
  const style = layer.style;
  const viz = layer.viz;
  const aggregated = isAggregated(viz);
  const kind = renderGeometryKind(render);

  const patch = (partial: Partial<LayerStyle>) =>
    onStyle({ ...style, ...partial });

  // The fill under edit: an aggregated layer styles its cells via the viz
  // fill; everything else styles the layer fill.
  const fill: FillPaint = aggregated && viz.fill ? viz.fill : style.fill;
  const setFillPaint = (f: FillPaint) =>
    aggregated ? onViz({ ...viz, fill: f }) : patch({ fill: f });
  const previewFillPaint = (f: FillPaint) =>
    aggregated ? onAggregatedFillPreview?.(f) : onStylePreview?.({ fill: f });
  const commitFillPaint = (f: FillPaint): Promise<boolean> =>
    aggregated
      ? (onAggregatedFillCommit?.(f) ?? Promise.resolve(false))
      : (onStyleCommit?.({ fill: f }) ?? Promise.resolve(false));

  const strokePartial = (p: FillPaint): Partial<LayerStyle> =>
    p.type === "constant"
      ? { stroke: p.color, strokeBy: undefined }
      : { strokeBy: p };
  const setStrokePaint = (p: FillPaint) => patch(strokePartial(p));

  const stylingFields = fields?.styling ?? [];
  const filterableFields = fields?.filterable ?? [];
  const numericBase = filterableFields.filter((f) => f.numeric);
  const numericStyling = stylingFields.filter((f) => f.numeric);

  // Origin→destination context: what the endpoints can map to, and whether
  // the arc/line tiles are available at all.
  const od = isOdViz(viz);
  const odViz = isOdViz(viz) ? viz : null;
  const odColumns = {
    geometryColumns: fields?.geometryColumns ?? [],
    numericColumns: numericBase.map((f) => f.name),
  };
  const tiled = Boolean(render?.ok && render.mode === "tiled");
  const odOptions = (current: OdEndpoint | null): OdEndpoint[] => {
    const candidates = odCandidates(odColumns);
    if (
      current &&
      !candidates.some((c) => endpointKey(c) === endpointKey(current))
    ) {
      return [current, ...candidates];
    }
    return candidates;
  };

  /** The attribute's stats for the ramp's distribution;
   * aggregated layers answer for value/count over the effective query. */
  const fetchStats = useCallback(
    async (attribute: string): Promise<FieldStats | null> => {
      const response = await fetch(
        `/api/layers/${layer.id}/fields/${encodeURIComponent(attribute)}`,
      );
      return response.ok
        ? ((await response.json()) as FieldStats)
        : null;
    },
    // Refetch when anything that shifts the distribution changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer.id, layer.sql, viz, layer.filters],
  );

  // visualization type ----

  // The type grid shows for every layer; tiles the data cannot support are
  // disabled with a reason rather than hidden or failable.

  const switchViz = (type: LayerViz["type"]) => {
    if (type === viz.type) return;
    if (type === "arc" || type === "line") {
      if (od) {
        // arc ⇄ line keeps endpoints, colors, and height.
        onViz({ ...viz, type });
        return;
      }
      // Endpoints map automatically when the columns say so; otherwise
      // the pane asks.
      const next = defaultViz(type) as OdViz;
      onViz({ ...next, ...(inferOd(odColumns) ?? {}) });
      return;
    }
    const next = defaultViz(type);
    if ((type === "hexbin" || type === "grid") && aggregated) {
      // hex ⇄ grid keeps what is being aggregated, at the same cell size.
      onViz({ ...next, aggregate: viz.aggregate, cellKm: viz.cellKm } as LayerViz);
    } else if (type === "cluster" && aggregated) {
      // An aggregation's what-is-measured carries into cluster color.
      onViz({ ...next, color: viz.aggregate } as LayerViz);
    } else {
      onViz(next);
    }
  };

  /** Change the aggregation itself: drop the fill so the server reclassifies
   * over the new value distribution, keeping the chosen ramp. */
  const patchAggregation = (partial: Partial<AggregatedViz>) => {
    if (!isAggregated(viz)) return;
    const next = { ...viz, ...partial } as AggregatedViz;
    delete next.fill;
    onViz(next);
  };

  /** Cell-size interaction keeps the settled fill while the cells move;
   * release drops it so the authoritative server result classifies once. */
  const previewAggregation = (partial: Partial<AggregatedViz>) => {
    if (!isAggregated(viz) || !onAggregationPreview) return;
    onAggregationPreview({ ...viz, ...partial } as AggregatedViz);
  };
  const commitAggregation = (
    partial: Partial<AggregatedViz>,
  ): Promise<boolean> => {
    if (!isAggregated(viz) || !onAggregationCommit) {
      return Promise.resolve(false);
    }
    const next = { ...viz, ...partial } as AggregatedViz;
    delete next.fill;
    return onAggregationCommit(next);
  };

  const changeAggregateFn = (fn: string) => {
    if (!isAggregated(viz)) return;
    if (fn === "count") {
      patchAggregation({ aggregate: { fn: "count" } });
      return;
    }
    const current =
      viz.aggregate.fn !== "count" ? viz.aggregate.attribute : undefined;
    const attributeName = current ?? numericBase[0]?.name;
    if (!attributeName) return;
    patchAggregation({
      aggregate: {
        fn: fn as Exclude<Aggregate["fn"], "count">,
        attribute: attributeName,
      },
    });
  };

  // extrusion ----

  /** Elevation edits keep the fill: height and its aggregate never reshape
   * the color distribution, so no reclassification round-trip. */
  const patchElevation = (elevation: CellElevation | undefined) => {
    if (!isAggregated(viz)) return;
    onViz({ ...viz, elevation } as LayerViz);
  };

  const changeElevationFn = (fn: string) => {
    if (!isAggregated(viz) || !viz.elevation) return;
    if (fn === "count") {
      patchElevation({ ...viz.elevation, aggregate: { fn: "count" } });
      return;
    }
    const current =
      viz.elevation.aggregate.fn !== "count"
        ? viz.elevation.aggregate.attribute
        : undefined;
    const attributeName = current ?? numericBase[0]?.name;
    if (!attributeName) return;
    patchElevation({
      ...viz.elevation,
      aggregate: {
        fn: fn as Exclude<Aggregate["fn"], "count">,
        attribute: attributeName,
      },
    });
  };

  const changeHeightBy = async (attribute: string) => {
    if (!attribute) {
      const next = { ...style };
      delete next.heightBy;
      onStyle(next);
      return;
    }
    const scale = await resolveScale(
      attribute,
      [0, style.heightBy?.range[1] ?? ELEVATION_HEIGHT.default],
      "m",
    );
    if (scale) patch({ heightBy: scale });
  };

  const extrudes =
    (aggregated && (viz as AggregatedViz).elevation !== undefined) ||
    (!aggregated && viz.type === "points" && style.heightBy !== undefined);

  // labels (off→on memory) ----

  const label = style.label;
  const { setLabelAttribute, setCellLabels } = useLabelSetters(
    layer.id,
    label,
    patch,
  );

  return {
    busy, channelError, dismissChannelError, classify, resolveScale, style, viz, kind,
    patch, fill, setFillPaint, previewFillPaint, commitFillPaint, strokePartial,
    setStrokePaint, stylingFields, filterableFields, numericBase, numericStyling, od,
    odViz, odColumns, tiled, odOptions, fetchStats, switchViz, patchAggregation,
    previewAggregation, commitAggregation, changeAggregateFn, patchElevation,
    changeElevationFn, changeHeightBy, extrudes, label, setLabelAttribute, setCellLabels,
  };
}

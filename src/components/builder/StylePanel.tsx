"use client";

import { useCallback, useEffect, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import type { FieldStats, LayerFieldsResult } from "@/lib/layer-service";
import { DEFAULT_FILL } from "@/lib/style/palettes";
import {
  defaultViz,
  isAggregated,
  isOdViz,
  ARC_HEIGHT,
  CLUSTER_RADIUS_PX,
  GRID_CELL_KM,
  HEX_CELL_KM,
  HEATMAP_RADIUS_PX,
  HEATMAP_INTENSITY,
  ELEVATION_HEIGHT,
  type Aggregate,
  type AggregatedViz,
  type CellElevation,
  type ClusterViz,
  type LayerFilter,
  type LayerViz,
  type OdViz,
} from "@/lib/viz";
import { representativeColor } from "@/lib/style/style";
import {
  inferOd,
  odCandidates,
  odPossible,
  type OdEndpoint,
} from "@/lib/od";
import type { MapTimeline } from "@/lib/timeline";
import type { HeatmapControlField } from "@/lib/heatmap-quality";
import {
  renderGeometryKind,
  vizTile,
  type GeometryKind,
  type LayerRenderData,
} from "./render-data";
import { CollapsibleSection } from "./CollapsibleSection";
import { SwitchRow } from "../ui/Switch";
import { HoverFieldsSections } from "./style-panel/HoverFieldsSections";
import { FilterSection } from "./FilterSection";
import {
  VizPointsIcon,
  VizPathIcon,
  VizPolygonIcon,
  VizArcIcon,
  VizLineIcon,
  VizClusterIcon,
  VizIconIcon,
  VizHexbinIcon,
  VizGridIcon,
  VizHeatmapIcon,
} from "../ui/icons";
import { IconPicker } from "./style-panel/IconPicker";
import { LabelSection } from "./style-panel/LabelSection";
import { PanelFailureNotes } from "./style-panel/PanelFailureNotes";
import { useStyleChannels } from "./style-panel/use-style-channels";
import { PaintControls } from "./style-panel/PaintControls";
import { SizeControl } from "./style-panel/SizeControl";
import { CellSizeRow } from "./style-panel/size-rows";
import { ColorRow, SelectRow, SliderRow } from "./style-panel/rows";
import { useLabelSetters } from "./style-panel/use-label-setters";
import styles from "./StylePanel.module.css";

interface Props {
  layer: Layer;
  render?: LayerRenderData;
  /** The renderer-settled label count for the Label
   * section's honest line; null while unknown. */
  labelCount?: import("./style-panel/LabelSection").LabelCount | null;
  onStyle: (style: LayerStyle) => void;
  onStylePreview?: (partial: Partial<LayerStyle>) => void;
  onStyleCommit?: (partial: Partial<LayerStyle>) => Promise<boolean>;
  onTooltip: (tooltip: string[] | null) => void;
  onPopup: (popup: string[] | null) => void;
  onViz: (viz: LayerViz) => void;
  onVizPreview?: (
    viz: LayerViz,
    field: HeatmapControlField,
  ) => void;
  onVizCommit?: (
    viz: LayerViz,
    field: HeatmapControlField,
  ) => Promise<boolean>;
  onAggregationPreview?: (viz: AggregatedViz) => void;
  onAggregationCommit?: (viz: AggregatedViz) => Promise<boolean>;
  onAggregatedFillPreview?: (fill: FillPaint) => void;
  onAggregatedFillCommit?: (fill: FillPaint) => Promise<boolean>;
  /** Cell height is appearance-only (field fix): previews repaint the
   * held cells live; commit persists without a render refetch. */
  onElevationPreview?: (elevation: CellElevation) => void;
  onElevationCommit?: (elevation: CellElevation) => Promise<boolean>;
  /** Arc/line/cluster appearance previews: height, target
   * color, and cluster radius draft live and commit without a refetch. */
  onOdPreview?: (viz: OdViz | ClusterViz) => void;
  onOdCommit?: (viz: OdViz | ClusterViz) => Promise<boolean>;
  onQueryPreviewStart?: () => void;
  onFilters: (filters: LayerFilter[]) => Promise<boolean>;
  onFilterPreview?: (filters: LayerFilter[]) => void;
  onFilterPreviewEnd?: (accepted: boolean) => void;
  /** The map's docked timeline + dock handlers, forwarded to
   * the filter section's time rows. */
  /** Current camera tilt in degrees — the fine pitch
   * control renders and writes through onPitch. */
  pitch?: number;
  onPitch?: (deg: number) => void;
  timeline?: MapTimeline | null;
  onDock?: (field: string) => void;
  onUndock?: () => void;
  /** Live filtering, forwarded to the filter section: which
   * fields the canvas enforces, and the mid-drag preview channel. */
  liveFields?: string[];
  onLivePreview?: (field: string, range: [number, number]) => void;
  onLivePreviewStart?: () => void;
  onLivePreviewEnd?: (accepted: boolean) => void;
}


/** The geometry tile draws the features as they are; its face follows the
 * layer's geometry family (Point/Path/Polygon, one tile). */
function geometryTile(kind: GeometryKind): {
  label: string;
  icon: React.ReactNode;
} {
  if (kind === "line") return { label: "Path", icon: <VizPathIcon /> };
  if (kind === "polygon")
    return { label: "Polygons", icon: <VizPolygonIcon /> };
  if (kind === "mixed") return { label: "Features", icon: <VizPointsIcon /> };
  return { label: "Points", icon: <VizPointsIcon /> };
}

const VIZ_TYPES: {
  key: LayerViz["type"];
  label: string;
  icon: React.ReactNode;
}[] = [
  { key: "points", label: "Points", icon: <VizPointsIcon /> },
  { key: "arc", label: "Arc", icon: <VizArcIcon /> },
  { key: "line", label: "Line", icon: <VizLineIcon /> },
  { key: "cluster", label: "Cluster", icon: <VizClusterIcon /> },
  { key: "icon", label: "Icon", icon: <VizIconIcon /> },
  { key: "hexbin", label: "Hex bins", icon: <VizHexbinIcon /> },
  { key: "grid", label: "Grid", icon: <VizGridIcon /> },
  { key: "heatmap", label: "Heatmap", icon: <VizHeatmapIcon /> },
];

/** Stable select value for an endpoint, independent of object key order. */
function endpointKey(endpoint: OdEndpoint | null): string {
  if (endpoint === null) return "";
  return endpoint.kind === "geometry"
    ? JSON.stringify(["g", endpoint.field])
    : JSON.stringify(["p", endpoint.lon, endpoint.lat]);
}

function endpointFromKey(key: string): OdEndpoint | null {
  if (!key) return null;
  const parts = JSON.parse(key) as string[];
  return parts[0] === "g"
    ? { kind: "geometry", field: parts[1] }
    : { kind: "lonlat", lon: parts[1], lat: parts[2] };
}

function endpointLabel(endpoint: OdEndpoint): string {
  return endpoint.kind === "geometry"
    ? endpoint.field
    : `${endpoint.lon} + ${endpoint.lat}`;
}

/** Fresh scale ranges when a size channel first goes data-driven (px). */
const DEFAULT_RADIUS_RANGE: [number, number] = [4, 28];
const DEFAULT_WIDTH_RANGE: [number, number] = [1, 8];

/** First target color when the O→D gradient turns on — the
 * violet the source ramp ends on in the design reference. */
const DEFAULT_TARGET_COLOR = { r: 122, g: 78, b: 147, a: 1 };

export function StylePanel({
  layer,
  render,
  labelCount,
  onStyle,
  onStylePreview,
  onStyleCommit,
  onTooltip,
  onPopup,
  onViz,
  onVizPreview,
  onVizCommit,
  onAggregationPreview,
  onAggregationCommit,
  onAggregatedFillPreview,
  onAggregatedFillCommit,
  onElevationPreview,
  onElevationCommit,
  onOdPreview,
  onOdCommit,
  onQueryPreviewStart,
  onFilters,
  onFilterPreview,
  onFilterPreviewEnd,
  pitch = 0,
  onPitch,
  timeline = null,
  onDock,
  onUndock,
  liveFields,
  onLivePreview,
  onLivePreviewStart,
  onLivePreviewEnd,
}: Props) {
  const [fields, setFields] = useState<LayerFieldsResult | null>(null);
  const { busy, channelError, dismissChannelError, classify, resolveScale } =
    useStyleChannels(layer.id);
  const style = layer.style;
  const viz = layer.viz;
  const aggregated = isAggregated(viz);
  const heatmap = viz.type === "heatmap";
  const kind = renderGeometryKind(render);

  // The styling columns depend on the SQL (editable via the API/assistant)
  // and the viz (aggregated layers expose value/count).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/layers/${layer.id}/fields`);
      if (response.ok && !cancelled)
        setFields((await response.json()) as LayerFieldsResult);
    })();
    return () => {
      cancelled = true;
    };
  }, [layer.id, layer.sql, viz.type]);

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

  // Which size channels apply (geometry-aware, cells stay constant):
  // radius for point results — icons size the same way — width for
  // line/polygon strokes.
  const sizableRadius =
    (viz.type === "points" || viz.type === "icon") &&
    (kind === "point" || kind === "mixed" || kind === null);
  const sizableWidth =
    !aggregated &&
    !heatmap &&
    (kind === "line" || kind === "polygon" || kind === "mixed" || od);

  return (
    <div className={styles.panel}>
      <PanelFailureNotes
        renderError={render && !render.ok ? (render.error ?? null) : null}
        channelError={channelError}
        onDismissChannelError={dismissChannelError}
      />

      {/* Visualization (type grid on every layer): unsupported tiles
          disable with a reason; opacity stays last. */}
      <CollapsibleSection layerId={layer.id} name="viz" label="Visualization">
        <div className={styles.segments}>
          {VIZ_TYPES.map((t) => {
            // A non-points viz renders cells/paths, but its BASE stays
            // point data — the geometry tile and the point-family tiles
            // describe the base, not the current render.
            const baseKind = viz.type === "points" ? kind : "point";
            const face =
              t.key === "points" ? { ...t, ...geometryTile(baseKind) } : t;
            const state = vizTile(kind, t.key, {
              tiled,
              odPossible: odPossible(odColumns),
              pointBase: viz.type !== "points",
            });
            return (
              <button
                key={t.key}
                className={styles.segment}
                data-active={viz.type === t.key}
                disabled={!state.available}
                data-hint={state.available ? undefined : state.reason}
                data-hint-always={state.available ? undefined : ""}
                aria-describedby={
                  state.available ? undefined : `viz-reason-${t.key}`
                }
                onClick={() => switchViz(t.key)}
              >
                {face.icon}
                {face.label}
                {!state.available && state.reason && (
                  <span id={`viz-reason-${t.key}`} hidden>
                    {state.reason}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {aggregated && (
          <>
            <SelectRow
              label="Show"
              name="Aggregate function"
              value={viz.aggregate.fn}
              onChange={changeAggregateFn}
            >
              <option value="count">Count of points</option>
              {numericBase.length > 0 && (
                <>
                  <option value="sum">Sum</option>
                  <option value="avg">Average</option>
                  <option value="min">Minimum</option>
                  <option value="max">Maximum</option>
                </>
              )}
            </SelectRow>
            {viz.aggregate.fn !== "count" && (
              <SelectRow
                label="of"
                name="Aggregate attribute"
                value={viz.aggregate.attribute}
                onChange={(value) =>
                  patchAggregation({
                    aggregate: {
                      fn: viz.aggregate.fn as Exclude<
                        Aggregate["fn"],
                        "count"
                      >,
                      attribute: value,
                    },
                  })
                }
              >
                {numericBase.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </SelectRow>
            )}
            <CellSizeRow
              cellKm={viz.cellKm}
              min={viz.type === "hexbin" ? HEX_CELL_KM.min : GRID_CELL_KM.min}
              max={viz.type === "hexbin" ? HEX_CELL_KM.max : GRID_CELL_KM.max}
              onChange={(cellKm) => patchAggregation({ cellKm })}
              onPreviewStart={onQueryPreviewStart}
              onPreview={
                onAggregationPreview
                  ? (cellKm) => previewAggregation({ cellKm })
                  : undefined
              }
              onCommit={
                onAggregationCommit
                  ? (cellKm) => commitAggregation({ cellKm })
                  : undefined
              }
            />

            {/* Extrusion: cells rise by an aggregate — color and height
                can encode different things. */}
            <SwitchRow
              className={styles.checkRow}
                checked={viz.elevation !== undefined}
                onChange={(e) =>
                  patchElevation(
                    e.target.checked
                      ? {
                          aggregate: { fn: "count" },
                          height: ELEVATION_HEIGHT.default,
                        }
                      : undefined,
                  )
                }
              label="Extrude cells (3D)"
            />
            {viz.elevation && (
              <>
                <SelectRow
                  label="Height by"
                  name="Cell height function"
                  value={viz.elevation.aggregate.fn}
                  onChange={changeElevationFn}
                >
                  <option value="count">Count of points</option>
                  {numericBase.length > 0 && (
                    <>
                      <option value="sum">Sum</option>
                      <option value="avg">Average</option>
                      <option value="min">Minimum</option>
                      <option value="max">Maximum</option>
                    </>
                  )}
                </SelectRow>
                {viz.elevation.aggregate.fn !== "count" && (
                  <SelectRow
                    label="of"
                    name="Cell height attribute"
                    value={viz.elevation.aggregate.attribute}
                    onChange={(value) =>
                      patchElevation({
                        ...viz.elevation!,
                        aggregate: {
                          fn: viz.elevation!.aggregate.fn as Exclude<
                            Aggregate["fn"],
                            "count"
                          >,
                          attribute: value,
                        },
                      })
                    }
                  >
                    {numericBase.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </SelectRow>
                )}
                <SliderRow
                  label="Max height"
                  min={ELEVATION_HEIGHT.min}
                  max={ELEVATION_HEIGHT.max}
                  step={100}
                  value={viz.elevation.height}
                  onChange={(height) =>
                    patchElevation({ ...viz.elevation!, height })
                  }
                  onPreview={
                    onElevationPreview
                      ? (height) =>
                          onElevationPreview({ ...viz.elevation!, height })
                      : undefined
                  }
                  onCommit={
                    onElevationCommit
                      ? (height) =>
                          onElevationCommit({ ...viz.elevation!, height })
                      : undefined
                  }
                />
              </>
            )}
          </>
        )}

        {/* Polygon extrusion: features rise by an attribute. */}
        {kind === "polygon" && viz.type === "points" && (
          <>
            <SelectRow
              label="Height by"
              name="Height attribute"
              value={style.heightBy?.attribute ?? ""}
              disabled={busy}
              onChange={(value) => void changeHeightBy(value)}
            >
              <option value="">None (flat)</option>
              {numericBase.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </SelectRow>
            {style.heightBy && (
              <SliderRow
                label="Max height"
                min={ELEVATION_HEIGHT.min}
                max={ELEVATION_HEIGHT.max}
                step={100}
                value={style.heightBy.range[1]}
                onChange={(h) =>
                  patch({ heightBy: { ...style.heightBy!, range: [0, h] } })
                }
                onPreview={
                  onStylePreview
                    ? (h) =>
                        onStylePreview({
                          heightBy: { ...style.heightBy!, range: [0, h] },
                        })
                    : undefined
                }
                onCommit={
                  onStyleCommit
                    ? (h) =>
                        onStyleCommit({
                          heightBy: { ...style.heightBy!, range: [0, h] },
                        })
                    : undefined
                }
              />
            )}
          </>
        )}

        {/* Fine pitch control — lives with the elevation settings; the
            stage-stack tilt button is the coarse toggle. */}
        {extrudes && onPitch && (
          <SliderRow
            label="Pitch"
            min={0}
            max={60}
            step={1}
            value={pitch}
            onChange={onPitch}
          />
        )}

        {odViz && (
          <>
            {(["origin", "dest"] as const).map((end) => (
              <SelectRow
                key={end}
                label={end === "origin" ? "Origin" : "Destination"}
                name={`${end === "origin" ? "Origin" : "Destination"} field`}
                value={endpointKey(odViz[end])}
                onChange={(value) =>
                  onViz({ ...odViz, [end]: endpointFromKey(value) })
                }
              >
                <option value="" disabled>
                  Choose a field…
                </option>
                {odOptions(odViz[end]).map((c) => (
                  <option key={endpointKey(c)} value={endpointKey(c)}>
                    {endpointLabel(c)}
                  </option>
                ))}
              </SelectRow>
            ))}
            {odViz.type === "arc" && (
              <SliderRow
                label="Arc height"
                value={odViz.height}
                min={ARC_HEIGHT.min}
                max={ARC_HEIGHT.max}
                step={0.05}
                onChange={(height) => onViz({ ...odViz, height })}
                onPreview={
                  onOdPreview
                    ? (height) => onOdPreview({ ...odViz, height })
                    : undefined
                }
                onCommit={
                  onOdCommit
                    ? (height) => onOdCommit({ ...odViz, height })
                    : undefined
                }
              />
            )}
            <SwitchRow
              className={styles.checkRow}
                checked={odViz.targetColor !== undefined}
                onChange={(e) => {
                  const next = { ...odViz };
                  if (e.target.checked) next.targetColor = DEFAULT_TARGET_COLOR;
                  else delete next.targetColor;
                  onViz(next);
                }}
              label="Blend toward a target color"
            />
            {odViz.targetColor && (
              <ColorRow
                label="Target"
                color={odViz.targetColor}
                onChange={(targetColor) => onViz({ ...odViz, targetColor })}
              />
            )}
          </>
        )}

        {viz.type === "icon" && (
          // Extracted with (the at-touch slice): the Maki grid and the
          // Custom reveal live in their own module.
          <IconPicker viz={viz} onViz={onViz} />
        )}

        {viz.type === "cluster" && (
          <>
            <SliderRow
              label="Cluster radius"
              value={viz.radiusPx}
              min={CLUSTER_RADIUS_PX.min}
              max={CLUSTER_RADIUS_PX.max}
              step={1}
              onChange={(radiusPx) => onViz({ ...viz, radiusPx })}
              onPreview={
                onOdPreview
                  ? (radiusPx) => onOdPreview({ ...viz, radiusPx })
                  : undefined
              }
              onCommit={
                onOdCommit
                  ? (radiusPx) => onOdCommit({ ...viz, radiusPx })
                  : undefined
              }
            />
            <SelectRow
              label="Color by"
              name="Cluster color function"
              value={viz.color === "fixed" ? "fixed" : viz.color.fn}
              onChange={(value) => {
                  if (value === "fixed") {
                    onViz({ ...viz, color: "fixed" });
                  } else if (value === "count") {
                    onViz({ ...viz, color: { fn: "count" } });
                  } else {
                    const current =
                      viz.color !== "fixed" && viz.color.fn !== "count"
                        ? viz.color.attribute
                        : undefined;
                    const attribute = current ?? numericBase[0]?.name;
                    if (!attribute) return;
                    onViz({
                      ...viz,
                      color: {
                        fn: value as Exclude<Aggregate["fn"], "count">,
                        attribute,
                      },
                    });
                  }
              }}
            >
              <option value="fixed">Fixed color</option>
              <option value="count">Point count</option>
              {numericBase.length > 0 && (
                <>
                  <option value="sum">Sum</option>
                  <option value="avg">Average</option>
                  <option value="min">Minimum</option>
                  <option value="max">Maximum</option>
                </>
              )}
            </SelectRow>
            {viz.color !== "fixed" && viz.color.fn !== "count" && (
              <SelectRow
                label="of"
                name="Cluster color attribute"
                value={viz.color.attribute}
                onChange={(value) =>
                  onViz({
                    ...viz,
                    color: {
                      fn: (viz.color as Exclude<ClusterViz["color"], "fixed">)
                        .fn as Exclude<Aggregate["fn"], "count">,
                      attribute: value,
                    },
                  })
                }
              >
                {numericBase.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </SelectRow>
            )}
            {viz.color === "fixed" && (
              <ColorRow
                label="Color"
                name="Cluster color"
                color={
                  style.fill.type === "constant"
                    ? style.fill.color
                    : representativeColor(style)
                }
                onChange={(color) =>
                  patch({ fill: { type: "constant", color } })
                }
              />
            )}
            <SwitchRow
              className={styles.checkRow}
                checked={viz.showCounts}
                onChange={(e) =>
                  onViz({ ...viz, showCounts: e.target.checked })
                }
              label="Show counts"
            />
          </>
        )}

        {heatmap && (
          <>
            <SliderRow
              label="Radius"
              value={viz.radiusPx}
              min={HEATMAP_RADIUS_PX.min}
              max={HEATMAP_RADIUS_PX.max}
              step={1}
              onChange={(radiusPx) => onViz({ ...viz, radiusPx })}
              onPreview={
                onVizPreview
                  ? (radiusPx) =>
                      onVizPreview({ ...viz, radiusPx }, "radiusPx")
                  : undefined
              }
              onCommit={
                onVizCommit
                  ? (radiusPx) =>
                      onVizCommit({ ...viz, radiusPx }, "radiusPx")
                  : undefined
              }
            />
            <SliderRow
              label="Intensity"
              value={viz.intensity}
              min={HEATMAP_INTENSITY.min}
              max={HEATMAP_INTENSITY.max}
              step={0.1}
              onChange={(intensity) => onViz({ ...viz, intensity })}
              onPreview={
                onVizPreview
                  ? (intensity) =>
                      onVizPreview({ ...viz, intensity }, "intensity")
                  : undefined
              }
              onCommit={
                onVizCommit
                  ? (intensity) =>
                      onVizCommit({ ...viz, intensity }, "intensity")
                  : undefined
              }
            />
            <SelectRow
              label="Weight"
              name="Heatmap weight attribute"
              value={viz.weight ?? ""}
              onChange={(value) => onViz({ ...viz, weight: value || null })}
            >
              <option value="">Each point counts 1</option>
              {numericBase.map((f) => (
                <option key={f.name} value={f.name}>
                  by {f.name}
                </option>
              ))}
            </SelectRow>
          </>
        )}

        {sizableRadius && (
          <SizeControl
            label={viz.type === "icon" ? "Icon size" : "Point size"}
            fixed={style.pointRadius}
            fixedMin={1}
            fixedMax={100}
            fixedStep={1}
            rangeCap={200}
            scale={style.pointRadiusBy}
            fields={numericStyling}
            disabled={busy}
            defaultRange={DEFAULT_RADIUS_RANGE}
            resolveScale={resolveScale}
            onFixed={(pointRadius) =>
              patch({ pointRadius, pointRadiusBy: undefined })
            }
            onFixedPreview={
              onStylePreview
                ? (pointRadius) =>
                    onStylePreview({ pointRadius, pointRadiusBy: undefined })
                : undefined
            }
            onFixedCommit={
              onStyleCommit
                ? (pointRadius) =>
                    onStyleCommit({ pointRadius, pointRadiusBy: undefined })
                : undefined
            }
            onScale={(pointRadiusBy) => patch({ pointRadiusBy })}
          />
        )}
        <SliderRow
          label="Layer opacity"
          value={style.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) => patch({ opacity })}
          onPreview={
            onStylePreview
              ? (opacity) => onStylePreview({ opacity })
              : undefined
          }
          onCommit={
            onStyleCommit
              ? (opacity) => onStyleCommit({ opacity })
              : undefined
          }
        />
      </CollapsibleSection>

      {/* Fill — lines have no area; heatmaps draw density, not fills;
          cluster bubbles pick their color in the cluster pane */}
      {kind !== "line" && !heatmap && viz.type !== "cluster" && (
        <CollapsibleSection layerId={layer.id} name="fill" label="Fill">
          <PaintControls
            paint={fill}
            fields={stylingFields}
            disabled={busy}
            channel="Fill"
            constantFallback={DEFAULT_FILL}
            classify={classify}
            fetchStats={fetchStats}
            onPaint={setFillPaint}
            onPaintPreview={previewFillPaint}
            onPaintCommit={commitFillPaint}
          />
          <SliderRow
            label="Fill opacity"
            value={style.fillOpacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(fillOpacity) => patch({ fillOpacity })}
            onPreview={
              onStylePreview
                ? (fillOpacity) => onStylePreview({ fillOpacity })
                : undefined
            }
            onCommit={
              onStyleCommit
                ? (fillOpacity) => onStyleCommit({ fillOpacity })
                : undefined
            }
          />
        </CollapsibleSection>
      )}

      {/* Stroke — heatmaps have none, icon glyphs are solid marks,
          cluster bubbles keep their white ring; aggregated cells keep a
          constant outline */}
      {!heatmap && viz.type !== "icon" && viz.type !== "cluster" && (
        <CollapsibleSection
          layerId={layer.id}
          name="stroke"
          label={kind === "line" ? "Stroke" : "Outline"}
        >
          {extrudes ? (
            // deck.gl draws no outlines on extruded geometry — dead controls
            // would just confuse (field fix). The settings stay put and
            // come back when the shapes flatten.
            <p className={styles.sectionHint}>
              Outlines don&apos;t render on extruded shapes. Turn 3D off to
              edit them.
            </p>
          ) : aggregated ? (
            <ColorRow
              label="Color"
              name="Outline color"
              color={style.stroke}
              onChange={(stroke) => patch({ stroke })}
            />
          ) : (
            <PaintControls
              paint={style.strokeBy ?? { type: "constant", color: style.stroke }}
              fields={stylingFields}
              disabled={busy}
              channel="Outline"
              constantFallback={style.stroke}
              classify={classify}
              fetchStats={fetchStats}
              onPaint={setStrokePaint}
              onPaintPreview={(p) => onStylePreview?.(strokePartial(p))}
              onPaintCommit={(p) =>
                onStyleCommit?.(strokePartial(p)) ?? Promise.resolve(false)
              }
            />
          )}
          {!extrudes && sizableWidth && (
            <SizeControl
              label="Width"
              fixed={style.strokeWidth}
              fixedMin={0}
              fixedMax={20}
              fixedStep={0.5}
              rangeCap={40}
              scale={style.strokeWidthBy}
              fields={numericStyling}
              disabled={busy}
              defaultRange={DEFAULT_WIDTH_RANGE}
              resolveScale={resolveScale}
              onFixed={(strokeWidth) =>
                patch({ strokeWidth, strokeWidthBy: undefined })
              }
              onFixedPreview={
                onStylePreview
                  ? (strokeWidth) =>
                      onStylePreview({
                        strokeWidth,
                        strokeWidthBy: undefined,
                      })
                  : undefined
              }
              onFixedCommit={
                onStyleCommit
                  ? (strokeWidth) =>
                      onStyleCommit({
                        strokeWidth,
                        strokeWidthBy: undefined,
                      })
                  : undefined
              }
              onScale={(strokeWidthBy) => patch({ strokeWidthBy })}
            />
          )}
          {!extrudes && !sizableWidth && (
            <SliderRow
              label="Width"
              value={style.strokeWidth}
              min={0}
              max={20}
              step={0.5}
              onChange={(strokeWidth) => patch({ strokeWidth })}
              onPreview={
                onStylePreview
                  ? (strokeWidth) => onStylePreview({ strokeWidth })
                  : undefined
              }
              onCommit={
                onStyleCommit
                  ? (strokeWidth) => onStyleCommit({ strokeWidth })
                  : undefined
              }
            />
          )}
          {!extrudes && (
            <SliderRow
              label="Stroke opacity"
              value={style.strokeOpacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(strokeOpacity) => patch({ strokeOpacity })}
              onPreview={
                onStylePreview
                  ? (strokeOpacity) => onStylePreview({ strokeOpacity })
                  : undefined
              }
              onCommit={
                onStyleCommit
                  ? (strokeOpacity) => onStyleCommit({ strokeOpacity })
                  : undefined
              }
            />
          )}
        </CollapsibleSection>
      )}

      {/* Labels — heatmaps have no discrete unit to label */}
      {!heatmap && (
        <CollapsibleSection layerId={layer.id} name="label" label="Label">
          <LabelSection
            label={label}
            aggregated={aggregated}
            tiled={tiled}
            stylingFields={stylingFields}
            numericFields={numericStyling}
            count={labelCount ?? null}
            setCellLabels={setCellLabels}
            setLabelAttribute={setLabelAttribute}
            patch={patch}
            onStylePreview={onStylePreview}
            onStyleCommit={onStyleCommit}
          />
        </CollapsibleSection>
      )}

      {/* Filters — refine the result; SQL stays the truth */}
      <FilterSection
        layer={layer}
        fields={filterableFields}
        onFilters={onFilters}
        onQueryPreview={onFilterPreview}
        onQueryPreviewStart={onQueryPreviewStart}
        onQueryPreviewEnd={onFilterPreviewEnd}
        timeline={timeline}
        onDock={onDock}
        onUndock={onUndock}
        liveFields={liveFields}
        onLivePreview={onLivePreview}
        onLivePreviewStart={onLivePreviewStart}
        onLivePreviewEnd={onLivePreviewEnd}
      />

      {/* Tooltip and pop-up fields — extracted to their own module
          slice; heatmaps are neither hoverable nor clickable, so the
          sections only exist off-heatmap. */}
      {!heatmap && (
        <HoverFieldsSections
          layer={layer}
          fields={stylingFields}
          onTooltip={onTooltip}
          onPopup={onPopup}
        />
      )}

    </div>
  );
}

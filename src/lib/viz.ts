import {
  isValidFill,
  isValidRgba,
  type FillPaint,
  type LayerStyle,
  type RgbaColor,
} from "@/lib/style/style";
import { isValidEndpoint, type OdEndpoint } from "@/lib/od";
import { DEFAULT_GLYPH, isMakiGlyph } from "@/lib/maki";

/**
 * Layer visualization config and filters. The viz decides how a layer's
 * result is drawn: raw features ("points", today's behavior), a server-side
 * aggregation (hex bins / grid) whose cells arrive as ordinary polygons, or
 * a heatmap rendered from the raw points. Filters refine the result without
 * touching the layer's SQL — remove them and the original result returns
 * exactly.
 */

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

/** What each cell shows: feature count, or an aggregate of an attribute. */
export type Aggregate =
  | { fn: "count" }
  | { fn: "sum" | "avg" | "min" | "max"; attribute: string };

export interface HexbinViz {
  type: "hexbin";
  /** Hexagon edge length in kilometers (planar tessellation in
   * web-mercator meters underneath —; any size, not H3 steps). */
  cellKm: number;
  aggregate: Aggregate;
  /** Fill over the aggregate value; assigned server-side when absent. */
  fill?: FillPaint;
  /** Cell extrusion; absent = flat, exactly as before. */
  elevation?: CellElevation;
}

export interface GridViz {
  type: "grid";
  /** Square cell edge in kilometers (web-mercator meters underneath). */
  cellKm: number;
  aggregate: Aggregate;
  fill?: FillPaint;
  /** Cell extrusion; absent = flat, exactly as before. */
  elevation?: CellElevation;
}

/**
 * Cell extrusion: cells rise by an aggregate — count by default, or a
 * function over a numeric field — so color and height can encode
 * different things. The aggregate's value range over the cells is
 * resolved server-side and maps linearly onto [0, height] meters, so the
 * height control means the same thing on any data.
 */
export interface CellElevation {
  aggregate: Aggregate;
  /** Tallest prism in meters. */
  height: number;
  /** Aggregate value range over the cells, resolved server-side. */
  domain?: [number, number];
}

export interface HeatmapViz {
  type: "heatmap";
  radiusPx: number;
  intensity: number;
  /** Numeric attribute weighting each point; null = every point counts 1. */
  weight: string | null;
}

/**
 * Origin→destination visualizations: each row draws as a pair taken from the
 * mapped endpoints. Arc swings between them with an adjustable height; line
 * is the straight connection (an arc of height 0 underneath, which is what
 * gives line its source→target gradient too). Null endpoints mean "not yet
 * mapped" — the layer asks instead of erroring. The path's source color and
 * width ride the layer style's stroke channels; `targetColor` blends toward
 * the destination, absent = one fixed color.
 */
export interface OdViz {
  type: "arc" | "line";
  origin: OdEndpoint | null;
  dest: OdEndpoint | null;
  /** Arc swing relative to the endpoint distance; ignored for line. */
  height: number;
  targetColor?: RgbaColor;
}

/**
 * Icon visualization: points render as a glyph from the curated bundled
 * set. Size rides the style's point-radius channel and color its fill
 * channel — fixed or by attribute — so the existing controls, legend,
 * labels, and pop-ups apply unchanged.
 */
export interface IconViz {
  type: "icon";
  glyph: string;
  /** Sanitized custom SVG markup; when present it wins over
   * the glyph. Written only through the layer API, whose sanitizer is
   * the gate — the value here is its accepted output. Null and absent
   * both mean "the glyph". */
  customSvg?: string | null;
}

/**
 * Cluster visualization: points aggregate client-side into count-labeled
 * bubbles by a screen-pixel radius; zooming in dissolves them toward
 * individual points. Bubble size encodes count; color is "fixed" (the
 * style's fill) or an aggregate on a sequential ramp over the current
 * view's values.
 */
export interface ClusterViz {
  type: "cluster";
  radiusPx: number;
  color: "fixed" | Aggregate;
  showCounts: boolean;
}

export type LayerViz =
  | { type: "points" }
  | HexbinViz
  | GridViz
  | HeatmapViz
  | OdViz
  | IconViz
  | ClusterViz;
export type AggregatedViz = HexbinViz | GridViz;

export function isOdViz(viz: LayerViz): viz is OdViz {
  return viz.type === "arc" || viz.type === "line";
}

/** One shared, continuous cell-size range for both aggregations. */
export const HEX_CELL_KM = { min: 0.02, max: 1000, default: 1.2 } as const;
export const GRID_CELL_KM = { min: 0.02, max: 1000, default: 5 } as const;
export const ARC_HEIGHT = { min: 0.1, max: 2, default: 0.6 } as const;
export const CLUSTER_RADIUS_PX = { min: 20, max: 120, default: 64 } as const;
export const HEATMAP_RADIUS_PX = { min: 1, max: 200, default: 30 } as const;
export const HEATMAP_INTENSITY = { min: 0.1, max: 10, default: 1 } as const;
export const ELEVATION_HEIGHT = { min: 100, max: 20000, default: 3000 } as const;

/** Column names an aggregated result exposes (see query/compile). */
export const AGG_VALUE = "value";
export const AGG_COUNT = "count";
/** Reserved elevation-value column; present only when a cell
 * elevation is configured, and never surfaced in tooltips or pop-ups. */
export const AGG_ELEV = "elev";

export const POINTS_VIZ: LayerViz = { type: "points" };

export function isAggregated(viz: LayerViz): viz is AggregatedViz {
  return viz.type === "hexbin" || viz.type === "grid";
}

/** True when a viz edit is appearance-only — the effective query does not
 * depend on it, so render data needs no refetch. Points has no
 * query-shaping props and the heatmap's radius/intensity/ weight all
 * draw from data the client already has; any type change, and any
 * aggregated edit (cell size, aggregate), reshapes the query. An
 * arc/line edit is appearance-only unless the endpoint mapping moved. */
export function vizAppearanceOnly(prev: LayerViz, next: LayerViz): boolean {
  if (prev.type !== next.type) return false;
  if (isAggregated(next)) return false;
  if (isOdViz(next) && isOdViz(prev)) {
    return (
      JSON.stringify(prev.origin ?? null) === JSON.stringify(next.origin ?? null) &&
      JSON.stringify(prev.dest ?? null) === JSON.stringify(next.dest ?? null)
    );
  }
  return true;
}

/** A fresh config for a visualization type, with agreed defaults. */
export function defaultViz(type: LayerViz["type"]): LayerViz {
  switch (type) {
    case "points":
      return { type: "points" };
    case "hexbin":
      return {
        type: "hexbin",
        cellKm: HEX_CELL_KM.default,
        aggregate: { fn: "count" },
      };
    case "grid":
      return {
        type: "grid",
        cellKm: GRID_CELL_KM.default,
        aggregate: { fn: "count" },
      };
    case "heatmap":
      return {
        type: "heatmap",
        radiusPx: HEATMAP_RADIUS_PX.default,
        intensity: HEATMAP_INTENSITY.default,
        weight: null,
      };
    case "arc":
    case "line":
      // Endpoints start unmapped; the builder fills them by inference when
      // it can, and the pane asks when it cannot.
      return {
        type,
        origin: null,
        dest: null,
        height: ARC_HEIGHT.default,
      };
    case "icon":
      return { type: "icon", glyph: DEFAULT_GLYPH };
    case "cluster":
      return {
        type: "cluster",
        radiusPx: CLUSTER_RADIUS_PX.default,
        color: { fn: "count" },
        showCounts: true,
      };
  }
}

/** The style a viewer must render: an aggregated layer draws its cells with
 * the viz fill — and cells keep one data-driven channel only, so the
 * outline/size channels are stripped; everything else draws the layer
 * style as-is. */
export function effectiveStyle(style: LayerStyle, viz: LayerViz): LayerStyle {
  if (!isAggregated(viz)) return style;
  const cells: LayerStyle = viz.fill ? { ...style, fill: viz.fill } : { ...style };
  delete cells.strokeBy;
  delete cells.pointRadiusBy;
  delete cells.strokeWidthBy;
  // Cells rise by the viz elevation, never the polygon channel.
  delete cells.heightBy;
  return cells;
}

function inRange(v: unknown, r: { min: number; max: number }): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max;
}

function isAggregate(value: unknown): value is Aggregate {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (a.fn === "count") return a.attribute === undefined;
  return (
    (a.fn === "sum" || a.fn === "avg" || a.fn === "min" || a.fn === "max") &&
    typeof a.attribute === "string" &&
    a.attribute.length > 0
  );
}

export function isValidViz(value: unknown): value is LayerViz {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type === "points") return true;
  if (v.type === "hexbin" || v.type === "grid") {
    if (!isAggregate(v.aggregate)) return false;
    if (v.fill !== undefined && !isValidFill(v.fill)) return false;
    if (v.elevation !== undefined) {
      const e = v.elevation as Record<string, unknown>;
      if (!e || typeof e !== "object" || !isAggregate(e.aggregate)) return false;
      if (!inRange(e.height, ELEVATION_HEIGHT)) return false;
      if (e.domain !== undefined) {
        const d = e.domain;
        const pair =
          Array.isArray(d) &&
          d.length === 2 &&
          d.every((n) => typeof n === "number" && Number.isFinite(n));
        if (!pair || (d as number[])[0] > (d as number[])[1]) return false;
      }
    }
    return inRange(v.cellKm, v.type === "hexbin" ? HEX_CELL_KM : GRID_CELL_KM);
  }
  if (v.type === "heatmap") {
    return (
      inRange(v.radiusPx, HEATMAP_RADIUS_PX) &&
      inRange(v.intensity, HEATMAP_INTENSITY) &&
      (v.weight === null || (typeof v.weight === "string" && v.weight.length > 0))
    );
  }
  if (v.type === "arc" || v.type === "line") {
    const endpoint = (e: unknown) => e === null || isValidEndpoint(e);
    return (
      endpoint(v.origin) &&
      endpoint(v.dest) &&
      inRange(v.height, ARC_HEIGHT) &&
      (v.targetColor === undefined || isValidRgba(v.targetColor))
    );
  }
  if (v.type === "icon") {
    return (
      isMakiGlyph(v.glyph) &&
      (v.customSvg === undefined ||
        v.customSvg === null ||
        typeof v.customSvg === "string")
    );
  }
  if (v.type === "cluster") {
    return (
      inRange(v.radiusPx, CLUSTER_RADIUS_PX) &&
      (v.color === "fixed" || isAggregate(v.color)) &&
      typeof v.showCounts === "boolean"
    );
  }
  return false;
}

/** Average H3 hex edge length in km per resolution — the migration table
 * for hex-bin configs saved (matches the old ≈-size readout). */
const H3_EDGE_KM: Record<number, number> = {
  3: 59.81,
  4: 22.61,
  5: 8.54,
  6: 3.23,
  7: 1.22,
  8: 0.461,
  9: 0.174,
  10: 0.066,
  11: 0.025,
};

/**
 * Normalize a stored viz on read. Hex bins persisted carry an H3 resolution
 * instead of a cell size; they load as the nearest visually equivalent edge
 * length. Everything else passes through — this runs wherever layer JSON
 * re-enters the process (rows, history snapshots), so no reader ever sees
 * the legacy shape.
 */
export function normalizeViz(value: LayerViz): LayerViz {
  if (value.type !== "hexbin") return value;
  const legacy = value as HexbinViz & { resolution?: number };
  if (typeof legacy.cellKm === "number") return value;
  const { resolution, ...rest } = legacy;
  const cellKm =
    resolution !== undefined
      ? (H3_EDGE_KM[resolution] ?? HEX_CELL_KM.default)
      : HEX_CELL_KM.default;
  return { ...rest, cellKm };
}

// ---- filters ----

export type LayerFilter =
  | { field: string; kind: "range"; min: number | null; max: number | null }
  | { field: string; kind: "timerange"; min: string | null; max: string | null }
  | {
      field: string;
      kind: "values";
      values: string[];
      /** True inverts the set (category exclusions) — keep
       * everything EXCEPT these values. Absent/false = membership. */
      exclude?: boolean;
    };

export const MAX_FILTERS = 16;
export const MAX_FILTER_VALUES = 200;

/** Time filter bounds travel as ISO-8601 strings (date, optionally with a
 * time part); anything else is rejected before it can reach SQL. */
const TIME_BOUND = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?$/;

export function isTimeBound(value: unknown): value is string {
  return typeof value === "string" && TIME_BOUND.test(value);
}

function isFilter(value: unknown): value is LayerFilter {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  if (typeof f.field !== "string" || f.field.length === 0) return false;
  if (f.kind === "range") {
    const bound = (b: unknown) =>
      b === null || (typeof b === "number" && Number.isFinite(b));
    return bound(f.min) && bound(f.max);
  }
  if (f.kind === "timerange") {
    const bound = (b: unknown) => b === null || isTimeBound(b);
    return bound(f.min) && bound(f.max);
  }
  if (f.kind === "values") {
    return (
      Array.isArray(f.values) &&
      f.values.length <= MAX_FILTER_VALUES &&
      f.values.every((v) => typeof v === "string") &&
      (f.exclude === undefined || typeof f.exclude === "boolean")
    );
  }
  return false;
}

export function isValidFilters(value: unknown): value is LayerFilter[] {
  return (
    Array.isArray(value) && value.length <= MAX_FILTERS && value.every(isFilter)
  );
}

// ---- legend text overrides ----

export const MAX_LEGEND_LABELS = 24;
export const MAX_LEGEND_TEXT = 120;

/** Per-entry label overrides, aligned with the legend's entries; null slots
 * (and entries past the end) keep their automatic label. */
export function isValidLegendLabels(
  value: unknown,
): value is (string | null)[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LEGEND_LABELS &&
    value.every(
      (v) => v === null || (typeof v === "string" && v.length <= MAX_LEGEND_TEXT),
    )
  );
}

/** The legend's channel keys (see style/legend): the color channels and the
 * size rows a layer can show. */
export const LEGEND_CHANNELS = [
  "fill",
  "stroke",
  "radius",
  "width",
  "height",
] as const;
export type LegendChannelKey = (typeof LEGEND_CHANNELS)[number];

/** Attribute-name overrides per legend channel. Three states per channel: a missing key (and null itself) keeps
 * the automatic attribute name, text overrides it, and an explicit null
 * value hides the attribute line entirely. */
export type LegendAttrs = Partial<Record<LegendChannelKey, string | null>>;

export function isValidLegendAttrs(value: unknown): value is LegendAttrs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([k, v]) =>
      (LEGEND_CHANNELS as readonly string[]).includes(k) &&
      (v === null ||
        (typeof v === "string" && v.length > 0 && v.length <= MAX_LEGEND_TEXT)),
  );
}

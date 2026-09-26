import type { LayerStyle, RgbaColor, FillPaint, SizeScale } from "./style";
import { isOdViz, type LayerViz } from "../viz";

export interface LegendEntry {
  label: string;
  color: RgbaColor;
}

/** The gradient block a continuous fill shows: the ramp bar
 * with its effective-domain end labels, and the center value when the ramp
 * diverges around one. */
export interface LegendRamp {
  /** Ramp stops low→high, reversal already applied. */
  colors: RgbaColor[];
  /** Stop positions 0–1 when not evenly spaced (custom palettes). */
  positions?: number[];
  /** Formatted effective-domain ends (low, high). */
  labels: [string, string];
  /** Formatted center value when a diverging split is set. */
  center?: string;
}

/** One data-driven color channel: the fill, or the outline. */
export interface LegendChannel {
  channel: "fill" | "stroke";
  attribute: string;
  kind: "quantile" | "categorical" | "continuous";
  /** Discrete rows; empty for a continuous channel (see `ramp`). */
  entries: LegendEntry[];
  /** The gradient, present exactly when kind is "continuous". */
  ramp?: LegendRamp;
}

/** One data-driven size channel: point radius, line width, or
 * extrusion height. */
export interface SizeChannel {
  channel: "radius" | "width" | "height";
  attribute: string;
  /** Formatted domain ends (low, high) — the automatic label text. */
  labels: [string, string];
  /** Output pixel range, for drawing the size glyphs. */
  range: [number, number];
}

/** Everything a layer's legend shows; channels in a stable order. */
export interface Legend {
  paints: LegendChannel[];
  sizes: SizeChannel[];
}

/** Class boundaries display EXACTLY — stored equals shown.
 * Breaks are nice by construction, so grouping is all they need; micro
 * magnitudes still read as exponents. Earlier raw breaks show their true
 * noise until reclassified — honest, not pretty. */
export function formatBreak(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs > 0 && abs < 1e-4) {
    return n.toExponential(2).replace(/\.?0+e/, "e");
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

/** Compact number formatting — map labels, cell tooltips, and size
 * legends, where approximate-but-tidy beats exact. Micro magnitudes switch
 * to exponent form instead of a wall of leading zeros. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs > 0 && abs < 1e-4) {
    return n.toExponential(2).replace(/\.?0+e/, "e");
  }
  if (abs >= 1000 || (abs < 0.01 && abs > 0)) {
    return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function paintChannel(
  channel: "fill" | "stroke",
  paint: FillPaint,
): LegendChannel | null {
  if (paint.type === "constant") return null;

  if (paint.type === "categorical") {
    const entries = paint.map.map((e) => ({ label: e.value, color: e.color }));
    entries.push({ label: "other", color: paint.other });
    return { channel, attribute: paint.attribute, kind: "categorical", entries };
  }

  if (paint.type === "continuous") {
    const [lo, hi] = paint.clamp ?? paint.domain;
    // Clamped ends read as open intervals — values beyond them still draw.
    const clampedLo = paint.clamp !== undefined && paint.clamp[0] > paint.domain[0];
    const clampedHi = paint.clamp !== undefined && paint.clamp[1] < paint.domain[1];
    return {
      channel,
      attribute: paint.attribute,
      kind: "continuous",
      entries: [],
      ramp: {
        colors: paint.stops,
        ...(paint.positions ? { positions: paint.positions } : {}),
        labels: [
          `${clampedLo ? "≤ " : ""}${formatCompact(lo)}`,
          `${clampedHi ? "≥ " : ""}${formatCompact(hi)}`,
        ],
        ...(paint.center !== undefined
          ? { center: formatCompact(paint.center) }
          : {}),
      },
    };
  }

  // quantile: colors.length classes, breaks between them
  const { breaks, colors } = paint;
  const entries: LegendEntry[] = colors.map((color, i) => {
    let label: string;
    if (i === 0) label = `< ${formatBreak(breaks[0])}`;
    else if (i === colors.length - 1) label = `≥ ${formatBreak(breaks[breaks.length - 1])}`;
    else label = `${formatBreak(breaks[i - 1])} – ${formatBreak(breaks[i])}`;
    return { label, color };
  });
  return { channel, attribute: paint.attribute, kind: "quantile", entries };
}

function sizeChannel(
  channel: "radius" | "width" | "height",
  scale: SizeScale,
): SizeChannel {
  return {
    channel,
    attribute: scale.attribute,
    labels: [formatCompact(scale.domain[0]), formatCompact(scale.domain[1])],
    range: scale.range,
  };
}

/**
 * The extrusion's legend row: cells rise by the viz elevation, simple
 * polygons by the style's height channel. Shown only when height encodes
 * something color does not — same source, one explanation.
 */
function heightChannel(style: LayerStyle, viz?: LayerViz): SizeChannel | null {
  if (viz && (viz.type === "hexbin" || viz.type === "grid")) {
    const elevation = viz.elevation;
    if (!elevation) return null;
    if (
      JSON.stringify(elevation.aggregate) === JSON.stringify(viz.aggregate)
    ) {
      return null;
    }
    const attribute =
      elevation.aggregate.fn === "count"
        ? "count"
        : `${elevation.aggregate.fn} ${elevation.aggregate.attribute}`;
    return {
      channel: "height",
      attribute,
      labels: elevation.domain
        ? [
            formatCompact(elevation.domain[0]),
            formatCompact(elevation.domain[1]),
          ]
        : ["low", "high"],
      range: [0, elevation.height],
    };
  }
  if (viz && viz.type !== "points") return null;
  const heightBy = style.heightBy;
  if (!heightBy) return null;
  const fill = style.fill;
  if (fill.type !== "constant" && fill.attribute === heightBy.attribute) {
    return null;
  }
  return sizeChannel("height", heightBy);
}

/** The class entries one paint produces — the builder's channel previews. */
export function paintLegend(paint: FillPaint): LegendChannel | null {
  return paintChannel("fill", paint);
}

/** The source→target block an O→D gradient shows: two color
 * rows a reader can decode, riding the stroke channel's override slots. */
function odChannel(style: LayerStyle, viz: LayerViz): LegendChannel | null {
  if (!isOdViz(viz) || !viz.targetColor) return null;
  return {
    channel: "stroke",
    attribute: "origin → destination",
    kind: "categorical",
    entries: [
      { label: "origin", color: style.stroke },
      { label: "destination", color: viz.targetColor },
    ],
  };
}

/**
 * Derive a legend from a style: every data-driven channel contributes a
 * block — fill and outline their classes, sizes a min→max row, and an O→D
 * gradient its source→target rows. Shared by builder and viewer so they
 * never disagree. Returns null when nothing is data-driven (an all-constant
 * style shows no legend).
 */
export function legendFor(style: LayerStyle, viz?: LayerViz): Legend | null {
  // Cluster bubbles encode count as size: the legend is that size
  // encoding; the layer's paint channels do not render.
  if (viz?.type === "cluster") {
    return {
      paints: [],
      sizes: [
        {
          channel: "radius",
          attribute: "point count",
          labels: ["fewer", "more"],
          range: [8, 28],
        },
      ],
    };
  }
  const od = viz && isOdViz(viz);
  const paints = [
    od ? null : paintChannel("fill", style.fill),
    viz ? odChannel(style, viz) : null,
    style.strokeBy ? paintChannel("stroke", style.strokeBy) : null,
  ].filter((p): p is LegendChannel => p !== null);
  const sizes = [
    style.pointRadiusBy ? sizeChannel("radius", style.pointRadiusBy) : null,
    style.strokeWidthBy ? sizeChannel("width", style.strokeWidthBy) : null,
    heightChannel(style, viz),
  ].filter((s): s is SizeChannel => s !== null);
  if (paints.length === 0 && sizes.length === 0) return null;
  return { paints, sizes };
}

/**
 * The one colour an all-constant layer draws: the stroke where the
 * geometry is stroked — line features, O→D paths — and the fill
 * elsewhere. Null when the style has data-driven channels (the legend
 * shows those instead) or the visualization owns its own presentation
 * (heatmap density, cluster counts).
 */
export function constantSwatch(
  style: LayerStyle,
  viz?: LayerViz,
  geometryType?: string | null,
): RgbaColor | null {
  if (viz?.type === "heatmap" || viz?.type === "cluster") return null;
  if (legendFor(style, viz) !== null) return null;
  const stroked =
    (viz ? isOdViz(viz) : false) || geometryType === "LINESTRING";
  if (stroked) return style.stroke;
  return style.fill.type === "constant" ? style.fill.color : style.stroke;
}

/**
 * How many label slots a style's legend exposes — paint entries plus one per
 * size row, in display order. Label overrides are positional; when this
 * count changes they stop matching and callers reset them.
 */
export function legendSlotCount(style: LayerStyle, viz?: LayerViz): number {
  const legend = legendFor(style, viz);
  if (!legend) return 0;
  return (
    legend.paints.reduce((n, p) => n + p.entries.length, 0) +
    legend.sizes.length
  );
}

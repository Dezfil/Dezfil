import type {
  LayerStyle,
  RgbaColor,
  FillPaint,
  ContinuousFill,
  SizeScale,
  LabelStyle,
} from "./style";
import { AGG_ELEV, type LayerViz, type OdViz } from "../viz";
import { formatCompact } from "./legend";
import { sampleRamp } from "./palettes";

/** Deck.gl expects [r, g, b, a] with alpha 0-255. */
export type DeckColor = [number, number, number, number];

function toDeck(c: RgbaColor, alphaMultiplier = 1): DeckColor {
  const a = Math.min(1, Math.max(0, c.a * alphaMultiplier));
  return [c.r, c.g, c.b, Math.round(a * 255)];
}

/**
 * deck.gl renders its `opacity` prop through a gamma curve (alpha =
 * opacity^(1/2.2), "perceptually linear") — which leaves the low end
 * lying: a slider at 0.05 draws at ~26% alpha, and a dense layer still
 * reads near-solid at "almost zero". Pre-compensating makes the layer
 * opacity slider mean its number, consistent with the fill and stroke
 * opacity channels (those multiply vertex alpha, which deck leaves
 * linear).
 */
export function layerOpacity(opacity: number): number {
  return Math.pow(Math.min(1, Math.max(0, opacity)), 2.2);
}

/**
 * A fill paint with every color forced fully opaque. Icon glyphs tint
 * through the fill channel, but the channel's colors carry authored alpha
 * (the 0.72 kepler-teal default) that the hex-only picker can never raise —
 * fine for area marks, wrong for a solid glyph. Translucency for icons
 * stays with the fill-opacity and layer-opacity sliders.
 */
export function opaqueFillPaint(fill: FillPaint): FillPaint {
  const solid = (c: RgbaColor): RgbaColor => (c.a === 1 ? c : { ...c, a: 1 });
  if (fill.type === "constant") return { ...fill, color: solid(fill.color) };
  if (fill.type === "categorical") {
    return {
      ...fill,
      map: fill.map.map((e) => ({ ...e, color: solid(e.color) })),
      other: solid(fill.other),
    };
  }
  if (fill.type === "continuous") {
    return { ...fill, stops: fill.stops.map(solid) };
  }
  return { ...fill, colors: fill.colors.map(solid) };
}

/** Resolution of the precomputed continuous ramp lookup — visually
 * indistinguishable from per-value interpolation, and it keeps the
 * accessor allocation-free across 100k features. */
const RAMP_LUT_SIZE = 256;

/**
 * The value → ramp-position mapping a continuous fill defines: clamp
 * narrows the effective domain, log warps it, the center (diverging
 * palettes) pins its value to the ramp midpoint. Shared by the fill
 * accessor and anything that must agree with it.
 */
export function continuousPosition(
  fill: ContinuousFill,
): (value: number) => number {
  const [lo, hi] = fill.clamp ?? fill.domain;
  const log = fill.log === true && lo > 0;
  const warp = log ? Math.log : (v: number) => v;
  const w0 = warp(lo);
  const w1 = warp(hi);
  const span = w1 - w0;
  // The center's ramp position; kept off the exact ends so both directions
  // always render.
  let tc: number | null = null;
  if (fill.center !== undefined && span > 0) {
    const t = (warp(fill.center) - w0) / span;
    tc = Math.min(0.98, Math.max(0.02, t));
  }
  return (value: number) => {
    if (!Number.isFinite(value) || span <= 0 || (log && value <= 0)) return 0;
    let t = Math.min(1, Math.max(0, (warp(value) - w0) / span));
    if (tc !== null) {
      t = t <= tc ? (0.5 * t) / tc : 0.5 + (0.5 * (t - tc)) / (1 - tc);
    }
    return t;
  };
}

function continuousAccessor(
  fill: ContinuousFill,
  fillOpacity: number,
): (f: GeoJsonFeature) => DeckColor {
  const position = continuousPosition(fill);
  const lut: DeckColor[] = Array.from({ length: RAMP_LUT_SIZE }, (_, i) =>
    toDeck(
      sampleRamp(fill.stops, fill.positions, i / (RAMP_LUT_SIZE - 1)),
      fillOpacity,
    ),
  );
  return (f) => {
    const raw = f.properties?.[fill.attribute];
    const v = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(v)) return lut[0];
    return lut[Math.round(position(v) * (RAMP_LUT_SIZE - 1))];
  };
}

/** Build a per-feature fill accessor from a fill paint (spec: data-driven fill). */
export function fillAccessor(
  fill: FillPaint,
  fillOpacity = 1,
): DeckColor | ((f: GeoJsonFeature) => DeckColor) {
  if (fill.type === "constant") {
    return toDeck(fill.color, fillOpacity);
  }
  if (fill.type === "categorical") {
    const lookup = new Map(
      fill.map.map((e) => [e.value, toDeck(e.color, fillOpacity)]),
    );
    const fallback = toDeck(fill.other, fillOpacity);
    return (f) => lookup.get(String(f.properties?.[fill.attribute])) ?? fallback;
  }
  if (fill.type === "continuous") {
    return continuousAccessor(fill, fillOpacity);
  }
  // quantile
  const colors = fill.colors.map((c) => toDeck(c, fillOpacity));
  const breaks = fill.breaks;
  return (f) => {
    const raw = f.properties?.[fill.attribute];
    const v = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(v)) return colors[0];
    let i = 0;
    while (i < breaks.length && v > breaks[i]) i++;
    return colors[Math.min(i, colors.length - 1)];
  };
}

/**
 * Per-feature size accessor from a size scale. Point radius uses the "sqrt"
 * curve: interpolation in square-root space, so a mark's area tracks the
 * value; line width uses "linear", honest for a one-dimensional mark.
 * Missing or non-numeric values draw at the smallest size; values beyond the
 * domain clamp to its ends.
 */
export function sizeAccessor(
  scale: SizeScale,
  curve: "sqrt" | "linear",
): (f: GeoJsonFeature) => number {
  const [r0, r1] = scale.range;
  // Sign-preserving sqrt so negative domains keep their order.
  const warp =
    curve === "sqrt"
      ? (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))
      : (v: number) => v;
  const w0 = warp(scale.domain[0]);
  const w1 = warp(scale.domain[1]);
  return (f) => {
    const raw = f.properties?.[scale.attribute];
    const v = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(v)) return r0;
    if (w1 === w0) return r0; // collapsed domain: no information, smallest mark
    const t = Math.min(1, Math.max(0, (warp(v) - w0) / (w1 - w0)));
    return r0 + (r1 - r0) * t;
  };
}

export interface GeoJsonFeature {
  properties?: Record<string, unknown> | null;
}

/** All deck.gl visual props for a GeoJsonLayer, derived from a LayerStyle.
 * `pixelScale` scales the floors the props would otherwise hard-code:
 * the export composition draws in a larger space and pins the authored
 * channels to their share of the image, so a floor that stayed at 1
 * device pixel would thin the smallest marks only there. */
export function deckLayerProps(style: LayerStyle, pixelScale = 1) {
  const strokeVisible = style.strokeWidthBy
    ? style.strokeWidthBy.range[1] > 0
    : style.strokeWidth > 0;
  return {
    getFillColor: fillAccessor(style.fill, style.fillOpacity),
    getLineColor: style.strokeBy
      ? fillAccessor(style.strokeBy, style.strokeOpacity)
      : toDeck(style.stroke, style.strokeOpacity),
    getLineWidth: style.strokeWidthBy
      ? sizeAccessor(style.strokeWidthBy, "linear")
      : style.strokeWidth,
    getPointRadius: style.pointRadiusBy
      ? sizeAccessor(style.pointRadiusBy, "sqrt")
      : style.pointRadius,
    opacity: layerOpacity(style.opacity),
    stroked: true,
    filled: true,
    pointRadiusUnits: "pixels" as const,
    lineWidthUnits: "pixels" as const,
    pointRadiusMinPixels: 1 * pixelScale,
    lineWidthMinPixels: strokeVisible ? 0.5 * pixelScale : 0,
  };
}

/**
 * Arc/line visual props: the path's source color and width ride the layer
 * style's stroke channels; the target color blends toward the destination
 * (absent = one fixed color). Line is an arc of height 0 — which is exactly
 * what gives it the same source→target gradient.
 */
export function odLayerProps(style: LayerStyle, viz: OdViz, pixelScale = 1) {
  const source = style.strokeBy
    ? fillAccessor(style.strokeBy, style.strokeOpacity)
    : toDeck(style.stroke, style.strokeOpacity);
  const target = viz.targetColor
    ? toDeck(viz.targetColor, style.strokeOpacity)
    : source;
  return {
    getSourceColor: source,
    getTargetColor: target,
    getWidth: style.strokeWidthBy
      ? sizeAccessor(style.strokeWidthBy, "linear")
      : Math.max(style.strokeWidth, 0.5 * pixelScale),
    getHeight: viz.type === "arc" ? viz.height : 0,
    widthUnits: "pixels" as const,
    widthMinPixels: 0.5 * pixelScale,
    opacity: layerOpacity(style.opacity),
  };
}

export function odUpdateTriggers(style: LayerStyle, viz: OdViz) {
  return {
    getSourceColor: [style.stroke, style.strokeBy, style.strokeOpacity],
    getTargetColor: [
      viz.targetColor ?? null,
      style.stroke,
      style.strokeBy,
      style.strokeOpacity,
    ],
    getWidth: [style.strokeWidth, style.strokeWidthBy],
    getHeight: [viz.type, viz.height],
  };
}

/**
 * deck.gl ignores changed function accessors unless told (the lesson, now
 * across four channels): every data-driven input is enumerated here, once,
 * for both the inline and the vector-tile rendering branches.
 */
export function deckUpdateTriggers(style: LayerStyle) {
  return {
    getFillColor: [style.fill, style.fillOpacity],
    getLineColor: [style.stroke, style.strokeBy, style.strokeOpacity],
    getLineWidth: [style.strokeWidth, style.strokeWidthBy],
    getPointRadius: [style.pointRadius, style.pointRadiusBy],
  };
}

/**
 * The extrusion channel a layer renders with: aggregated cells rise by the
 * viz elevation (its server-resolved domain mapped linearly onto [0,
 * height] meters), simple polygons by the style's height-by scale. Null =
 * flat — rendering is exactly as before.
 */
export function extrusionScale(
  style: LayerStyle,
  viz?: LayerViz,
): SizeScale | null {
  if (viz && (viz.type === "hexbin" || viz.type === "grid")) {
    const elevation = viz.elevation;
    if (!elevation) return null;
    return {
      attribute: AGG_ELEV,
      domain: elevation.domain ?? [0, 1],
      range: [0, elevation.height],
    };
  }
  if (viz && viz.type !== "points") return null;
  return style.heightBy ?? null;
}

/** Extra GeoJsonLayer props when a layer extrudes; spread after
 * deckLayerProps. Heights map linearly — honest for a volume read on a
 * fixed footprint — and missing values stay flat. */
export function extrusionProps(scale: SizeScale) {
  return {
    extruded: true,
    wireframe: false,
    getElevation: sizeAccessor(scale, "linear"),
  };
}

export interface LabeledFeature extends GeoJsonFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/**
 * Per-feature label text. With an attribute, the text is that property's
 * value — numbers compactly formatted, same as the legend. With no
 * attribute (aggregated layers), the cell labels itself with `value`. Null
 * means "no label for this feature" and the feature is filtered out: so
 * does a value that is only blank space, which would draw nothing yet
 * still take up a label's room on the map.
 */
export function labelText(
  label: LabelStyle,
): (f: LabeledFeature) => string | null {
  const source = label.attribute;
  // Case before truncation; truncation counts Unicode code points and
  // the ellipsis is not counted.
  const cased = (t: string): string =>
    label.textCase === "upper"
      ? t.toUpperCase()
      : label.textCase === "lower"
        ? t.toLowerCase()
        : t;
  const truncated = (t: string): string => {
    const max = label.maxChars;
    if (max == null) return t;
    const points = Array.from(t);
    return points.length <= max ? t : `${points.slice(0, max).join("")}…`;
  };
  return (f) => {
    const raw = source ? f.properties?.[source] : f.properties?.value;
    if (raw === null || raw === undefined || raw === "") return null;
    const base = typeof raw === "number" ? formatCompact(raw) : String(raw);
    // Checked before truncation, which would leave a long blank its ellipsis.
    if (base.trim() === "") return null;
    return truncated(cased(base));
  };
}

/** The nine-point anchor's deck decomposition: horizontal
 * anchor plus vertical baseline, from the compass name. */
export function labelAnchorProps(anchor: LabelStyle["anchor"]): {
  getTextAnchor: "start" | "middle" | "end";
  getAlignmentBaseline: "top" | "center" | "bottom";
} {
  const a = anchor ?? "center";
  // A label anchored at the feature's TOP sits above it (text bottom on
  // the point), and so around the compass.
  const horizontal = a.endsWith("left")
    ? "end"
    : a.endsWith("right")
      ? "start"
      : a === "left"
        ? "end"
        : a === "right"
          ? "start"
          : "middle";
  const vertical = a.startsWith("top")
    ? "bottom"
    : a.startsWith("bottom")
      ? "top"
      : "center";
  return { getTextAnchor: horizontal, getAlignmentBaseline: vertical };
}

/**
 * Where a feature's label sits: points on themselves, everything else on
 * the server-computed interior anchor (the reserved __anchor property).
 */
export function labelPosition(f: LabeledFeature): [number, number] | null {
  const anchor = f.properties?.__anchor;
  if (Array.isArray(anchor) && anchor.length === 2) {
    return anchor as [number, number];
  }
  const g = f.geometry;
  if (g?.type === "Point") return g.coordinates as [number, number];
  if (g?.type === "MultiPoint") {
    return (g.coordinates as [number, number][])[0] ?? null;
  }
  return null;
}

/**
 * Visual props for a label text sublayer, shared by the inline and the
 * vector-tile rendering branches (like deckLayerProps for the marks).
 * The label carries the halo as width + color and the new styling
 * properties — all fixed values (L4), so every accessor here is a
 * constant per layer.
 */
export function deckLabelProps(label: LabelStyle) {
  const text = labelText(label);
  return {
    // Data is pre-filtered to labeled features; "" covers the impossible.
    getText: (f: LabeledFeature) => text(f) ?? "",
    getSize: label.size,
    getColor: toDeck(label.color),
    ...labelAnchorProps(label.anchor),
    getPixelOffset: [label.offsetX ?? 0, label.offsetY ?? 0] as [
      number,
      number,
    ],
    // deck's getAngle is counter-clockwise positive — the spec states
    // the same convention, so the value passes through unmapped.
    getAngle: label.rotation ?? 0,
    fontWeight: label.weight === "bold" ? 700 : 400,
    sizeUnits: "pixels" as const,
    // SDF text with an outline is the halo; width 0 disables it cleanly.
    fontSettings: { sdf: true },
    // Relative to the glyph's SDF buffer, NOT pixels (verified in deck's
    // multi-icon layer: buffer × (1 − outlineWidth)) — so it already
    // scales with the pinned text size and must never be multiplied
    // (scaling it saturated the halo at fine steps).
    outlineWidth: label.haloWidth,
    outlineColor: toDeck(label.haloColor),
    // The atlas follows the data — umlauts and beyond, not just ASCII.
    characterSet: "auto" as const,
    pickable: false,
  };
}

/** Update triggers for the label sublayer (the lesson, fifth
 * channel). Text-changing inputs (attribute, case, truncation) key
 * getText; appearance-only inputs key their own accessors — cached
 * label DATA identity is deliberately untouched by either (the fix:
 * appearance edits never rebuild label data). */
export function deckLabelTriggers(label: LabelStyle) {
  return {
    getText: [label.attribute ?? null, label.textCase ?? null, label.maxChars ?? null],
    getSize: [label.size],
    getColor: [label.color],
    getPixelOffset: [label.offsetX ?? 0, label.offsetY ?? 0],
    getAngle: [label.rotation ?? 0],
    getTextAnchor: [label.anchor ?? "center"],
    getAlignmentBaseline: [label.anchor ?? "center"],
  };
}

/**
 * Cell labels size in ground meters, not screen pixels:
 * the text keeps a fixed proportion of its cell across zoom, shrinking
 * and growing with the map. Returns the base text height for the default
 * label size — roughly a quarter of the cell's visual footprint — or
 * null for anything that isn't an aggregated cell.
 */
export function cellLabelMeters(viz?: LayerViz): number | null {
  if (viz?.type === "hexbin") return viz.cellKm * 1000 * 0.5;
  if (viz?.type === "grid") return viz.cellKm * 1000 * 0.25;
  return null;
}

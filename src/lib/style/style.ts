/**
 * The declarative layer style (spec: Maps & visual styling). A layer's full
 * visual definition — constant channels plus at most one data-driven fill.
 * Kept declarative and complete so an agent can drive it and the viewer and
 * builder can render it identically.
 */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Categorical fill: one color per distinct value, from a curated palette. */
export interface CategoricalFill {
  type: "categorical";
  attribute: string;
  palette: string;
  /** Palette applied back-to-front (recorded so the builder shows the state). */
  reversed?: boolean;
  /** Value → color, resolved at style time; unlisted values use `other`. */
  map: { value: string; color: RgbaColor }[];
  other: RgbaColor;
}

/**
 * Ramp fill: numeric attribute bucketed into ramp colors by breaks. The wire
 * type stays "quantile" for compatibility; `method` records how the breaks
 * were computed (quantile by default, equal intervals, or natural breaks).
 */
export interface QuantileFill {
  type: "quantile";
  attribute: string;
  palette: string;
  /** Requested class count when low-cardinality data can currently realize
   * fewer classes. Omitted when the visible colors already preserve it. */
  classes?: number;
  /** How the breaks were computed; "custom" = hand-edited. */
  method?: "quantile" | "equal" | "natural" | "custom";
  /** The named method a custom scale derived from; a class-count change
   * recomputes from it. */
  baseMethod?: "quantile" | "equal" | "natural";
  reversed?: boolean;
  /** Upper bounds of each class except the last (length = colors - 1). */
  breaks: number[];
  colors: RgbaColor[];
}

/**
 * Continuous (unclassed) ramp fill: values map smoothly onto the ramp over a
 * server-resolved domain. Colors are baked into `stops` at style time so the
 * paint stays self-contained — a published map survives the later deletion
 * of the palette it came from. `clamp` narrows the effective domain (values
 * outside take the end colors); `log` interpolates in log space (strictly
 * positive effective domains only); `center` splits the ramp's two halves
 * around a value — the diverging read. The builder offers the center only
 * for diverging-group palettes; the model just records it.
 */
export interface ContinuousFill {
  type: "continuous";
  attribute: string;
  palette: string;
  /** Ramp applied back-to-front (recorded so the builder shows the state). */
  reversed?: boolean;
  /** Attribute value range over the effective result (low, high). */
  domain: [number, number];
  /** Effective min/max inside the domain; values outside take the ends. */
  clamp?: [number, number];
  /** Interpolate in log space; requires a strictly positive effective domain. */
  log?: boolean;
  /** Value the ramp diverges around; maps to the ramp's midpoint. */
  center?: number;
  /** Ramp stops low→high, reversal already applied; evenly spaced unless
   * `positions` says otherwise. */
  stops: RgbaColor[];
  /** Stop positions (0–1, non-decreasing, one per stop) — custom palettes. */
  positions?: number[];
}

export type FillPaint =
  | { type: "constant"; color: RgbaColor }
  | CategoricalFill
  | QuantileFill
  | ContinuousFill;

/**
 * Numeric attribute → output size mapping. The domain is the attribute's
 * value range over the effective result, resolved server-side; the range
 * is the output in pixels. Point radius maps area-honestly (square root of
 * the value); line width maps linearly — see the accessor bridge.
 */
export interface SizeScale {
  attribute: string;
  /** Attribute value range the scale spans (low, high). */
  domain: [number, number];
  /** Output pixel range (smallest, largest); missing values draw smallest. */
  range: [number, number];
}

/** Sanity cap for scale output ranges — far above any sensible mark size. */
export const SIZE_RANGE_MAX_PX = 200;

/** Extrusion height cap in meters — far above any sensible prism. */
export const EXTRUSION_MAX_M = 100_000;

/** Sanity cap for label text size — far above any sensible map label. */
export const LABEL_SIZE_MAX_PX = 72;

/**
 * Text labels on features. On a simple-feature layer the text is the
 * attribute's value per feature; on an aggregated (hex/grid) layer the
 * attribute is omitted and each cell labels itself with its aggregate value.
 * Absent `label` = no labels. Heatmaps never label (nothing discrete to
 * anchor to).
 */
/** The nine label anchor positions. */
export const LABEL_ANCHORS = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type LabelAnchor = (typeof LABEL_ANCHORS)[number];

export const LABEL_CASES = ["as-is", "upper", "lower"] as const;
export type LabelCase = (typeof LABEL_CASES)[number];

/** The historical halo color — what `halo: true` always painted; the
 * one-time read migration pins legacy maps to it exactly. */
export const LEGACY_HALO_COLOR: RgbaColor = { r: 12, g: 16, b: 24, a: 0.8 };

/** Domains for the label properties (validated field by field). */
export const LABEL_OFFSET_MAX = 50;
export const LABEL_ROTATION_MAX = 180;
export const LABEL_MAX_CHARS = { min: 1, max: 80 } as const;
export const LABEL_CAP = { min: 1, max: 10_000 } as const;

export interface LabelStyle {
  /** Source attribute; omit on aggregated layers (the cell's value labels it). */
  attribute?: string;
  /** Text size in pixels. */
  size: number;
  color: RgbaColor;
  /** Halo rim width, 0–1 (the renderer's honorable range; 0 = none).
   * Replaced the legacy boolean: stored `halo: true` reads as 1 with
   * the historical color, `false` as 0. */
  haloWidth: number;
  haloColor: RgbaColor;
  /** Absent reads as "normal". */
  weight?: "normal" | "bold";
  /** Absent reads as "center". */
  anchor?: LabelAnchor;
  /** Pixel offset; +x right, +y down; each −50…50; absent = 0. */
  offsetX?: number;
  offsetY?: number;
  /** Degrees, −180…180, counter-clockwise positive; absent = 0. */
  rotation?: number;
  /** Absent reads as "as-is". */
  textCase?: LabelCase;
  /** Truncate to N code points with an ellipsis (1–80); null/absent =
   * no truncation. Applied after case. */
  maxChars?: number | null;
  /** Thinning (automatic mode) — collision density 0–1;
   * absent reads as 0.5. */
  density?: number;
  /** Show labels from this zoom; null/absent = no floor. */
  zoomFloor?: number | null;
  /** Numeric column ranking collision/cap survival; null/absent = the
   * stable feature order. */
  priorityField?: string | null;
  /** Draw at most N labels (1–10000); null/absent = no cap. */
  cap?: number | null;
}

export interface LayerStyle {
  fill: FillPaint;
  /** 0-1 multiplier on the fill alpha, independent of the stroke. */
  fillOpacity: number;
  stroke: RgbaColor;
  /** 0-1 multiplier on the stroke alpha, independent of the fill. */
  strokeOpacity: number;
  strokeWidth: number;
  pointRadius: number;
  opacity: number;
  /** Data-driven outline color; absent = the constant `stroke`. */
  strokeBy?: FillPaint;
  /** Data-driven point radius; absent = the constant `pointRadius`. */
  pointRadiusBy?: SizeScale;
  /** Data-driven line/outline width; absent = the constant `strokeWidth`. */
  strokeWidthBy?: SizeScale;
  /** Polygon extrusion by attribute: the domain maps linearly
   * onto meters. Absent = flat, exactly as before. */
  heightBy?: SizeScale;
  /** Text labels; absent = none. */
  label?: LabelStyle;
}

/** Solid — the default stroke translucency lives in strokeOpacity. */
export const DEFAULT_STROKE: RgbaColor = { r: 12, g: 16, b: 24, a: 1 };

export function isDataDriven(style: LayerStyle): boolean {
  return style.fill.type !== "constant";
}

function paintAlphaMax(paint: FillPaint): number {
  switch (paint.type) {
    case "constant":
      return paint.color.a;
    case "categorical":
      return Math.max(paint.other.a, ...paint.map.map((e) => e.color.a));
    case "quantile":
      return Math.max(0, ...paint.colors.map((c) => c.a));
    case "continuous":
      return Math.max(0, ...paint.stops.map((c) => c.a));
  }
}

function alphaScaled(c: RgbaColor, factor: number): RgbaColor {
  return { ...c, a: Math.min(1, c.a / factor) };
}

function paintAlphaScaled(paint: FillPaint, factor: number): FillPaint {
  switch (paint.type) {
    case "constant":
      return { ...paint, color: alphaScaled(paint.color, factor) };
    case "categorical":
      return {
        ...paint,
        map: paint.map.map((e) => ({ ...e, color: alphaScaled(e.color, factor) })),
        other: alphaScaled(paint.other, factor),
      };
    case "quantile":
      return { ...paint, colors: paint.colors.map((c) => alphaScaled(c, factor)) };
    case "continuous":
      return { ...paint, stops: paint.stops.map((c) => alphaScaled(c, factor)) };
  }
}

/**
 * Styles persisted or sent lack the split opacities; fill the defaults in
 * so every style read anywhere is complete. Applied on every metadata
 * read and on every accepted style write.
 *
 * Colors are solid and the opacity sliders own all translucency — so the
 * sliders mean their number and 100% is opaque. Legacy styles carried the
 * translucency inside the colors instead (0.72 constants, 0.82 ramps);
 * fold that authored alpha into the sliders
 * exactly — each color scales up by the channel's max alpha and the
 * slider scales down by it, so the rendered output is unchanged while
 * the sliders start telling the truth. Idempotent: a folded channel's
 * max alpha is 1.
 */
export function normalizeStyle(value: unknown): LayerStyle {
  const s = value as LayerStyle;
  let fill = s.fill;
  let fillOpacity = typeof s.fillOpacity === "number" ? s.fillOpacity : 1;
  const fillA = fill ? paintAlphaMax(fill) : 1;
  if (fillA > 0 && fillA < 1) {
    fill = paintAlphaScaled(fill, fillA);
    fillOpacity = Math.min(1, fillOpacity * fillA);
  }
  let stroke = s.stroke;
  let strokeBy = s.strokeBy;
  let strokeOpacity =
    typeof s.strokeOpacity === "number" ? s.strokeOpacity : 1;
  const strokeA = stroke
    ? Math.max(stroke.a, strokeBy ? paintAlphaMax(strokeBy) : 0)
    : 1;
  if (strokeA > 0 && strokeA < 1) {
    stroke = alphaScaled(stroke, strokeA);
    if (strokeBy) strokeBy = paintAlphaScaled(strokeBy, strokeA);
    strokeOpacity = Math.min(1, strokeOpacity * strokeA);
  }
  // The halo migration, at the one read boundary every stored style
  // crosses — including styles restored verbatim from legacy undo/redo
  // images: `halo: true` becomes width 1 with the historical color
  // (pixel-identical by construction), `false` becomes width 0.
  let label = s.label;
  if (label && typeof (label as { halo?: unknown }).halo === "boolean") {
    const { halo, ...rest } = label as LabelStyle & { halo: boolean };
    label = {
      ...rest,
      haloWidth: halo ? 1 : 0,
      haloColor: LEGACY_HALO_COLOR,
    };
  }
  return {
    ...s,
    fill,
    stroke,
    ...(strokeBy !== undefined && { strokeBy }),
    ...(label !== undefined && { label }),
    fillOpacity,
    strokeOpacity,
  };
}

/** True if the style could be produced by the builder; used to validate API writes. */
export function isValidStyle(value: unknown): value is LayerStyle {
  return styleProblem(value) === null;
}

/**
 * Why a style write is rejected, in one sentence — or null when the style is
 * valid. Manual break and color editing made bad values easy to produce, so
 * rejections must explain themselves, not just refuse.
 */
export function styleProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") return "Expected a style object.";
  const s = value as Record<string, unknown>;
  if (!isColor(s.stroke)) return "stroke must be a color.";
  if (!isFinitePositive(s.strokeWidth))
    return "strokeWidth must be a non-negative number.";
  if (!isFinitePositive(s.pointRadius))
    return "pointRadius must be a non-negative number.";
  if (!isUnit(s.opacity)) return "opacity must be between 0 and 1.";
  // Split opacities arrived with; absent means 1 (see normalizeStyle).
  if (s.fillOpacity !== undefined && !isUnit(s.fillOpacity))
    return "fillOpacity must be between 0 and 1.";
  if (s.strokeOpacity !== undefined && !isUnit(s.strokeOpacity))
    return "strokeOpacity must be between 0 and 1.";
  const fill = paintProblem(s.fill, "fill");
  if (fill) return fill;
  if (s.strokeBy !== undefined) {
    const p = paintProblem(s.strokeBy, "strokeBy");
    if (p) return p;
  }
  if (s.pointRadiusBy !== undefined) {
    const p = scaleProblem(s.pointRadiusBy, "pointRadiusBy");
    if (p) return p;
  }
  if (s.strokeWidthBy !== undefined) {
    const p = scaleProblem(s.strokeWidthBy, "strokeWidthBy");
    if (p) return p;
  }
  if (s.heightBy !== undefined) {
    const p = scaleProblem(s.heightBy, "heightBy", EXTRUSION_MAX_M);
    if (p) return p;
  }
  if (s.label !== undefined) {
    const p = labelProblem(s.label);
    if (p) return p;
  }
  return null;
}

/** Why a label config is invalid, or null. Field-specific wordings —
 * the documented contract. */
function labelProblem(value: unknown): string | null {
  if (!value || typeof value !== "object")
    return "label must be a label object.";
  const l = value as Record<string, unknown>;
  if (
    l.attribute !== undefined &&
    (typeof l.attribute !== "string" || l.attribute.length === 0)
  )
    return "label.attribute must be a non-empty attribute name when present.";
  if (
    typeof l.size !== "number" ||
    !Number.isFinite(l.size) ||
    l.size < 1 ||
    l.size > LABEL_SIZE_MAX_PX
  )
    return `label.size must be a number of pixels, 1 to ${LABEL_SIZE_MAX_PX}.`;
  if (!isColor(l.color)) return "label needs a valid color.";
  if (l.halo !== undefined)
    return (
      "label.halo has been replaced: send label.haloWidth (0 to 1) and " +
      "label.haloColor. Stored maps migrate on read."
    );
  if (
    typeof l.haloWidth !== "number" ||
    !Number.isFinite(l.haloWidth) ||
    l.haloWidth < 0 ||
    l.haloWidth > 1
  )
    return "label.haloWidth must be a number, 0 to 1 (0 = no halo).";
  if (!isColor(l.haloColor)) return "label.haloColor must be a valid color.";
  if (
    l.weight !== undefined &&
    l.weight !== "normal" &&
    l.weight !== "bold"
  )
    return 'label.weight accepts "normal" or "bold".';
  if (
    l.anchor !== undefined &&
    !(LABEL_ANCHORS as readonly unknown[]).includes(l.anchor)
  )
    return `label.anchor accepts ${LABEL_ANCHORS.join(", ")}.`;
  for (const axis of ["offsetX", "offsetY"] as const) {
    const v = l[axis];
    if (
      v !== undefined &&
      (typeof v !== "number" ||
        !Number.isFinite(v) ||
        Math.abs(v) > LABEL_OFFSET_MAX)
    )
      return `label.${axis} must be a number of pixels, -${LABEL_OFFSET_MAX} to ${LABEL_OFFSET_MAX}.`;
  }
  if (
    l.rotation !== undefined &&
    (typeof l.rotation !== "number" ||
      !Number.isFinite(l.rotation) ||
      Math.abs(l.rotation) > LABEL_ROTATION_MAX)
  )
    return `label.rotation must be degrees, -${LABEL_ROTATION_MAX} to ${LABEL_ROTATION_MAX} (counter-clockwise positive).`;
  if (
    l.textCase !== undefined &&
    !(LABEL_CASES as readonly unknown[]).includes(l.textCase)
  )
    return `label.textCase accepts ${LABEL_CASES.join(", ")}.`;
  if (
    l.maxChars !== undefined &&
    l.maxChars !== null &&
    (typeof l.maxChars !== "number" ||
      !Number.isInteger(l.maxChars) ||
      l.maxChars < LABEL_MAX_CHARS.min ||
      l.maxChars > LABEL_MAX_CHARS.max)
  )
    return `label.maxChars must be a whole number, ${LABEL_MAX_CHARS.min} to ${LABEL_MAX_CHARS.max}, or null for no truncation.`;
  if (
    l.density !== undefined &&
    (typeof l.density !== "number" ||
      !Number.isFinite(l.density) ||
      l.density < 0 ||
      l.density > 1)
  )
    return "label.density must be a number, 0 (sparse) to 1 (dense).";
  if (
    l.zoomFloor !== undefined &&
    l.zoomFloor !== null &&
    (typeof l.zoomFloor !== "number" ||
      !Number.isInteger(l.zoomFloor) ||
      l.zoomFloor < 0 ||
      l.zoomFloor > 24)
  )
    return "label.zoomFloor must be a whole zoom level, 0 to 24, or null for none.";
  if (
    l.priorityField !== undefined &&
    l.priorityField !== null &&
    (typeof l.priorityField !== "string" || l.priorityField.length === 0)
  )
    return "label.priorityField must be a non-empty column name, or null for feature order.";
  if (
    l.cap !== undefined &&
    l.cap !== null &&
    (typeof l.cap !== "number" ||
      !Number.isInteger(l.cap) ||
      l.cap < LABEL_CAP.min ||
      l.cap > LABEL_CAP.max)
  )
    return `label.cap must be a whole number, ${LABEL_CAP.min} to ${LABEL_CAP.max}, or null for no cap.`;
  return null;
}

function isUnit(v: unknown): boolean {
  return typeof v === "number" && v >= 0 && v <= 1;
}

export function isValidFill(value: unknown): value is FillPaint {
  return paintProblem(value, "fill") === null;
}

/** Why a paint (fill or data-driven outline) is invalid, or null. */
export function paintProblem(value: unknown, channel: string): string | null {
  if (!value || typeof value !== "object")
    return `${channel} must be a paint object.`;
  const f = value as Record<string, unknown>;
  if (f.type === "constant") {
    return isColor(f.color) ? null : `${channel} needs a valid color.`;
  }
  if (f.type === "categorical") {
    const ok =
      typeof f.attribute === "string" &&
      typeof f.palette === "string" &&
      Array.isArray(f.map) &&
      f.map.every(
        (e) =>
          e &&
          typeof (e as Record<string, unknown>).value === "string" &&
          isColor((e as Record<string, unknown>).color),
      ) &&
      isColor(f.other);
    return ok ? null : `${channel} has a malformed categorical paint.`;
  }
  if (f.type === "quantile") {
    const shape =
      typeof f.attribute === "string" &&
      typeof f.palette === "string" &&
      (f.method === undefined ||
        f.method === "quantile" ||
        f.method === "equal" ||
        f.method === "natural" ||
        f.method === "custom") &&
      (f.baseMethod === undefined ||
        f.baseMethod === "quantile" ||
        f.baseMethod === "equal" ||
        f.baseMethod === "natural") &&
      (f.classes === undefined ||
        (typeof f.classes === "number" &&
          Number.isInteger(f.classes) &&
          f.classes >= 2 &&
          f.classes <= 12)) &&
      Array.isArray(f.breaks) &&
      f.breaks.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      Array.isArray(f.colors) &&
      f.colors.length >= 2 &&
      f.colors.every(isColor) &&
      f.breaks.length === f.colors.length - 1;
    if (!shape) return `${channel} has a malformed ramp paint.`;
    const breaks = f.breaks as number[];
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i] <= breaks[i - 1]) {
        return `${channel} class boundaries must be in ascending order, each boundary greater than the previous one.`;
      }
    }
    return null;
  }
  if (f.type === "continuous") {
    const pair = (v: unknown): v is [number, number] =>
      Array.isArray(v) &&
      v.length === 2 &&
      v.every((n) => typeof n === "number" && Number.isFinite(n));
    const shape =
      typeof f.attribute === "string" &&
      typeof f.palette === "string" &&
      pair(f.domain) &&
      Array.isArray(f.stops) &&
      f.stops.length >= 2 &&
      f.stops.every(isColor);
    if (!shape) return `${channel} has a malformed continuous paint.`;
    const domain = f.domain as [number, number];
    if (domain[0] > domain[1])
      return `${channel} needs a domain of two numbers, low to high.`;
    if (f.clamp !== undefined) {
      if (!pair(f.clamp)) return `${channel} clamp must be two numbers.`;
      const clamp = f.clamp as [number, number];
      if (clamp[0] >= clamp[1] || clamp[0] < domain[0] || clamp[1] > domain[1])
        return `${channel} clamp must be ascending and inside the domain.`;
    }
    if (f.log !== undefined && typeof f.log !== "boolean")
      return `${channel} log must be true or false.`;
    const effective = (f.clamp as [number, number] | undefined) ?? domain;
    if (f.log === true && effective[0] <= 0)
      return `${channel} log scale needs a strictly positive domain.`;
    if (f.center !== undefined) {
      if (
        typeof f.center !== "number" ||
        !Number.isFinite(f.center) ||
        f.center < effective[0] ||
        f.center > effective[1]
      )
        return `${channel} center must be a number inside the effective domain.`;
    }
    if (f.positions !== undefined) {
      const stops = f.stops as unknown[];
      const p = f.positions;
      const ok =
        Array.isArray(p) &&
        p.length === stops.length &&
        p.every(
          (n, i) =>
            typeof n === "number" &&
            n >= 0 &&
            n <= 1 &&
            (i === 0 || n >= (p[i - 1] as number)),
        );
      if (!ok)
        return `${channel} positions must be 0–1, non-decreasing, one per stop.`;
    }
    return null;
  }
  return `${channel} has an unknown paint type.`;
}

/** Why a size scale (point radius / line width by attribute) is invalid, or null. */
function scaleProblem(
  value: unknown,
  channel: string,
  cap: number = SIZE_RANGE_MAX_PX,
): string | null {
  if (!value || typeof value !== "object")
    return `${channel} must be a scale object.`;
  const s = value as Record<string, unknown>;
  if (typeof s.attribute !== "string" || s.attribute.length === 0)
    return `${channel} needs an attribute.`;
  const pair = (v: unknown): v is [number, number] =>
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!pair(s.domain) || s.domain[0] > s.domain[1])
    return `${channel} needs a domain of two numbers, low to high.`;
  if (
    !pair(s.range) ||
    s.range[0] < 0 ||
    s.range[0] > s.range[1] ||
    s.range[1] > cap
  )
    return `${channel} needs an output range of two numbers, 0 to ${cap}, smallest first.`;
  return null;
}

export function isValidRgba(value: unknown): value is RgbaColor {
  return isColor(value);
}

function isColor(value: unknown): value is RgbaColor {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    channel(c.r) &&
    channel(c.g) &&
    channel(c.b) &&
    typeof c.a === "number" &&
    c.a >= 0 &&
    c.a <= 1
  );
}

function channel(v: unknown): boolean {
  return typeof v === "number" && v >= 0 && v <= 255;
}

function isFinitePositive(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * One color that stands for the whole layer: the constant fill, a
 * categorical fill's first mapped color, or a ramp's middle color. Used by
 * the maps listing for the card's layer dots — representative, not exact.
 */
export function representativeColor(style: LayerStyle): RgbaColor {
  const fill = style.fill;
  if (fill.type === "constant") return fill.color;
  if (fill.type === "categorical") return fill.map[0]?.color ?? fill.other;
  if (fill.type === "continuous") {
    return (
      fill.stops[Math.floor(fill.stops.length / 2)] ??
      fill.stops[0] ?? { r: 128, g: 128, b: 128, a: 1 }
    );
  }
  return (
    fill.colors[Math.floor(fill.colors.length / 2)] ??
    fill.colors[0] ?? { r: 128, g: 128, b: 128, a: 1 }
  );
}

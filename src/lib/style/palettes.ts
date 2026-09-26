import type { RgbaColor } from "./style";
import {
  CONTINUOUS_STOPS,
  BREWER_LEVELS,
  QUALITATIVE_CYCLES,
} from "./palette-data";

/**
 * The curated palette catalogue: every palette earns its slot, the inherited
 * ramps beside the standards users expect (viridis family, ColorBrewer, Turbo,
 * Berlin, Tab10), vendored upstream-exact in palette-data.ts. The kepler
 * entries — the layer color cycle, the "Global Warming" default ramp, and the
 * qualitative palette — are adapted from kepler.gl (MIT, © Uber Technologies /
 * OpenJS Foundation); "Bold" is CARTO Colors (CC-BY). See NOTICE for the
 * attribution ledger.
 */

export interface Palette {
  /** Stable id, stored in styles. */
  name: string;
  /** Label shown in the picker. */
  label: string;
  /** The mechanical axis: what the palette classifies (validation, defaults). */
  kind: "sequential" | "categorical";
  /** The browsing axis: how the picker groups it. Diverging
   * palettes stay kind "sequential" — same methods, steps, and reverse. */
  group: "sequential" | "diverging" | "qualitative";
  /** Upstream colorblind-safe designation — never self-certified; where the
   * source flags per class count, safe means safe across every count offered. */
  colorblindSafe: boolean;
  /** Ramp stops (sequential; interpolated to any class count) or the cycle (categorical). */
  colors: string[];
  /** Published per-class-count sets (ColorBrewer): a k-class rendering uses
   * the source's own k-class colors instead of sampling `colors`. */
  levels?: Record<number, string[]>;
}

/** Kepler.gl's DataVizColors — its layer color cycle and qualitative palette. */
const KEPLER_QUALITATIVE = [
  "#12939A", "#DDB27C", "#88572C", "#FF991F", "#F15C17",
  "#223F9A", "#DA70BF", "#125C77", "#4DC19C", "#776E57",
  "#17B8BE", "#F6D18A", "#B7885E", "#FFCB99", "#F89570",
  "#829AE3", "#E79FD5", "#1E96BE", "#89DAC1", "#B3AD9E",
];

export const PALETTES: Palette[] = [
  // ---- sequential ----
  {
    name: "global_warming",
    label: "Global Warming",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: false,
    colors: ["#5A1846", "#900C3F", "#C70039", "#E3611C", "#F1920E", "#FFC300"],
  },
  {
    name: "sunrise",
    label: "Sunrise",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: false,
    colors: ["#355C7D", "#C06C84", "#F8B195"],
  },
  {
    name: "uber_viz_sequential",
    label: "Viz Sequential",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: false,
    colors: ["#E6FAFA", "#C1E5E6", "#9DD0D4", "#75BBC1", "#4BA7AF", "#00939C"],
  },
  {
    name: "viridis",
    label: "Viridis",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: CONTINUOUS_STOPS.viridis,
  },
  {
    name: "plasma",
    label: "Plasma",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: CONTINUOUS_STOPS.plasma,
  },
  {
    name: "inferno",
    label: "Inferno",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: CONTINUOUS_STOPS.inferno,
  },
  {
    name: "greys",
    label: "Greys",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: BREWER_LEVELS.Greys[9],
    levels: BREWER_LEVELS.Greys,
  },
  {
    name: "blues",
    label: "Blues",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: BREWER_LEVELS.Blues[9],
    levels: BREWER_LEVELS.Blues,
  },
  {
    name: "greens",
    label: "Greens",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: BREWER_LEVELS.Greens[9],
    levels: BREWER_LEVELS.Greens,
  },
  {
    name: "reds",
    label: "Reds",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: BREWER_LEVELS.Reds[9],
    levels: BREWER_LEVELS.Reds,
  },
  {
    name: "ylorrd",
    label: "YlOrRd",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: true,
    colors: BREWER_LEVELS.YlOrRd[9],
    levels: BREWER_LEVELS.YlOrRd,
  },
  {
    name: "turbo",
    label: "Turbo",
    kind: "sequential",
    group: "sequential",
    colorblindSafe: false,
    colors: CONTINUOUS_STOPS.turbo,
  },
  // ---- diverging (kind "sequential": same mechanics, browsed apart) ----
  {
    name: "ice_and_fire",
    label: "Ice & Fire",
    kind: "sequential",
    group: "diverging",
    colorblindSafe: false,
    colors: ["#0198BD", "#FAFEB3", "#FEEDB1", "#D50255"],
  },
  {
    name: "rdbu",
    label: "RdBu",
    kind: "sequential",
    group: "diverging",
    colorblindSafe: true,
    colors: BREWER_LEVELS.RdBu[11],
    levels: BREWER_LEVELS.RdBu,
  },
  {
    name: "piyg",
    label: "PiYG",
    kind: "sequential",
    group: "diverging",
    colorblindSafe: true,
    colors: BREWER_LEVELS.PiYG[11],
    levels: BREWER_LEVELS.PiYG,
  },
  {
    name: "spectral",
    label: "Spectral",
    kind: "sequential",
    group: "diverging",
    colorblindSafe: false,
    colors: BREWER_LEVELS.Spectral[11],
    levels: BREWER_LEVELS.Spectral,
  },
  {
    name: "berlin",
    label: "Berlin",
    kind: "sequential",
    group: "diverging",
    colorblindSafe: true,
    colors: CONTINUOUS_STOPS.berlin,
  },
  // ---- qualitative ----
  {
    name: "uber_viz_qualitative",
    label: "Viz Qualitative",
    kind: "categorical",
    group: "qualitative",
    colorblindSafe: false,
    colors: KEPLER_QUALITATIVE,
  },
  {
    name: "bold",
    label: "Bold",
    kind: "categorical",
    group: "qualitative",
    colorblindSafe: false,
    colors: [
      "#7f3c8d", "#11a579", "#3969ac", "#f2b701", "#e73f74",
      "#80ba5a", "#e68310", "#008695", "#cf1c90", "#f97b72",
    ],
  },
  {
    name: "tab10",
    label: "Tab10",
    kind: "categorical",
    group: "qualitative",
    colorblindSafe: false,
    colors: QUALITATIVE_CYCLES.tab10,
  },
  {
    name: "paired",
    label: "Paired",
    kind: "categorical",
    group: "qualitative",
    colorblindSafe: false,
    colors: QUALITATIVE_CYCLES.paired,
  },
  {
    name: "dark2",
    label: "Dark2",
    kind: "categorical",
    group: "qualitative",
    colorblindSafe: false,
    colors: QUALITATIVE_CYCLES.dark2,
  },
  {
    name: "set3",
    label: "Set3",
    kind: "categorical",
    group: "qualitative",
    colorblindSafe: false,
    colors: QUALITATIVE_CYCLES.set3,
  },
];

/** Kepler.gl's defaults, inherited. */
export const DEFAULT_SEQUENTIAL = "global_warming";
export const DEFAULT_CATEGORICAL = "uber_viz_qualitative";

export function paletteByName(
  name: string,
  kind: Palette["kind"],
): Palette | undefined {
  return PALETTES.find((p) => p.name === name && p.kind === kind);
}

function hex(h: string, a = 1): RgbaColor {
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
    a,
  };
}

/**
 * New layers cycle through kepler.gl's layer colors by creation order — the
 * first layer gets kepler's signature teal (default styling).
 */
export function layerCycleColor(index: number, alpha = 1): RgbaColor {
  const n = KEPLER_QUALITATIVE.length;
  return hex(KEPLER_QUALITATIVE[((index % n) + n) % n], alpha);
}

/** The default constant fill for a freshly created layer (cycle start).
 * Solid — translucency belongs to the opacity sliders, not the colors. */
export const DEFAULT_FILL: RgbaColor = hex(KEPLER_QUALITATIVE[0], 1);

/**
 * A sequential palette's k-class hex colors: the published k-class set where
 * the source defines one (upstream-exact), sampled from the ramp stops
 * otherwise. Counts outside the published range sample the densest set.
 */
function sequentialHexes(p: Palette, count: number, reversed: boolean): string[] {
  const exact = p.levels?.[count];
  if (exact) return reversed ? [...exact].reverse() : exact;
  const stops = p.levels
    ? p.levels[Math.max(...Object.keys(p.levels).map(Number))]
    : p.colors;
  const ordered = reversed ? [...stops].reverse() : stops;
  return rampSample(ordered, count);
}

export function sequentialColors(
  count: number,
  palette: string = DEFAULT_SEQUENTIAL,
  reversed = false,
): RgbaColor[] {
  const p =
    paletteByName(palette, "sequential") ??
    paletteByName(DEFAULT_SEQUENTIAL, "sequential")!;
  return sequentialHexes(p, count, reversed).map((h) => hex(h, 1));
}

export function categoricalColors(
  count: number,
  palette: string = DEFAULT_CATEGORICAL,
  reversed = false,
): RgbaColor[] {
  const base =
    paletteByName(palette, "categorical")?.colors ??
    paletteByName(DEFAULT_CATEGORICAL, "categorical")!.colors;
  const ordered = reversed ? [...base].reverse() : base;
  return Array.from({ length: count }, (_, i) =>
    hex(ordered[i % ordered.length], 1),
  );
}

/**
 * A palette drawn at a class count, as hex — what the picker's ramp swatches
 * show (every ramp discretized at the current step count). Sequential
 * palettes discretize; categorical ones show their cycle.
 */
export function paletteSwatch(p: Palette, count: number, reversed = false): string[] {
  if (p.kind === "categorical") {
    return reversed ? [...p.colors].reverse() : p.colors;
  }
  return sequentialHexes(p, count, reversed);
}

/**
 * A sequential palette's full ramp as colors: the densest published set
 * for level palettes, the raw stops otherwise — what a continuous fill
 * bakes in at style time. Same alpha as classed ramps.
 */
export function continuousStops(
  palette: string = DEFAULT_SEQUENTIAL,
  reversed = false,
): RgbaColor[] {
  const p =
    paletteByName(palette, "sequential") ??
    paletteByName(DEFAULT_SEQUENTIAL, "sequential")!;
  const stops = p.levels
    ? p.levels[Math.max(...Object.keys(p.levels).map(Number))]
    : p.colors;
  const ordered = reversed ? [...stops].reverse() : stops;
  return ordered.map((h) => hex(h, RAMP_ALPHA));
}

/**
 * Ramp colors are solid. Alpha used to be baked in here (0.82 for area
 * marks), which capped fills below opaque with the opacity
 * slider lying at 100% — translucency now belongs entirely to the fill,
 * stroke, and layer opacity sliders. Legacy styles fold their authored
 * alpha into those sliders on read (see normalizeStyle).
 */
export const RAMP_ALPHA = 1;

/** Hex → ramp color — custom palette stops resolve through this. */
export function rampStopColor(h: string): RgbaColor {
  return hex(h, RAMP_ALPHA);
}

/**
 * Interpolate a ramp's color at t (0–1). Stops are evenly spaced unless
 * `positions` (0–1, non-decreasing, one per stop) says otherwise — equal
 * neighboring positions read as a hard step, like CSS gradients.
 */
export function sampleRamp(
  stops: RgbaColor[],
  positions: number[] | undefined,
  t: number,
): RgbaColor {
  const tt = Math.min(1, Math.max(0, t));
  if (stops.length === 1) return stops[0];
  if (!positions) {
    const x = tt * (stops.length - 1);
    const lo = Math.floor(x);
    const hi = Math.min(lo + 1, stops.length - 1);
    return mixColor(stops[lo], stops[hi], x - lo);
  }
  if (tt <= positions[0]) return stops[0];
  for (let i = 0; i < positions.length - 1; i++) {
    if (tt <= positions[i + 1]) {
      const span = positions[i + 1] - positions[i];
      const f = span <= 0 ? 1 : (tt - positions[i]) / span;
      return mixColor(stops[i], stops[i + 1], f);
    }
  }
  return stops[stops.length - 1];
}

/** `count` evenly spaced colors from explicit ramp stops — how a custom
 * palette serves a classed ramp (usable in both modes). */
export function rampColors(
  stops: RgbaColor[],
  positions: number[] | undefined,
  count: number,
): RgbaColor[] {
  if (count <= 1) return [sampleRamp(stops, positions, 0.5)];
  return Array.from({ length: count }, (_, i) =>
    sampleRamp(stops, positions, i / (count - 1)),
  );
}

function mixColor(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: a.a + (b.a - a.a) * t,
  };
}

/** Sample `count` colors evenly across a ramp, interpolating in RGB. */
function rampSample(stops: string[], count: number): string[] {
  if (count <= 1) return [stops[Math.floor(stops.length / 2)]];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (stops.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(lo + 1, stops.length - 1);
    out.push(mix(stops[lo], stops[hi], t - lo));
  }
  return out;
}

function mix(a: string, b: string, t: number): string {
  const ca = hex(a);
  const cb = hex(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

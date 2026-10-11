import type { BasemapKey } from "@/lib/basemap";
import { DEFAULT_CATEGORICAL, paletteByName } from "@/lib/style/palettes";
import { SAMPLE_GROUNDS } from "./basemap-grounds";
import styles from "./MapsTab.module.css";

/**
 * The New layers card's sample, and the color cycle's swatches: what a new
 * layer of each kind looks like with the kept defaults. The map's and the
 * palette's colors are data, drawn inline; nothing else here has a color
 * of its own.
 */

export interface SampleLook {
  /** The basemap a new map starts on, Auto already resolved by the theme. */
  readonly basemap: BasemapKey;
  /** The categorical palette new layers take their colors from in turn. */
  readonly palette: string;
  /** Each kind's opacity, in percent. */
  readonly pointOpacity: number;
  readonly lineOpacity: number;
  readonly areaOpacity: number;
  /** In pixels. */
  readonly lineWidth: number;
  readonly pointRadius: number;
}

/** The three points' places in the sample's 196 by 46. */
const POINTS: readonly (readonly [number, number])[] = [[16, 14], [30, 26], [44, 12]];
/** The widest line and the largest point the sample can hold, in pixels. */
const LINE_MAX = 12, RADIUS_MAX = 14;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const cycle = (palette: string) => (paletteByName(palette, "categorical") ?? paletteByName(DEFAULT_CATEGORICAL, "categorical"))!.colors;

/** Three points, a line and an area on a small map of the basemap, in the
 * order new layers take the cycle's colors, each at its opacity; the line
 * at its width and the points at their radius, in pixels, up to what the
 * sample can hold. A new area has no outline. */
export function LayerSample({ look }: { look: SampleLook }) {
  const ground = SAMPLE_GROUNDS[look.basemap], colors = cycle(look.palette);
  const color = (index: number) => colors[index % colors.length];
  const share = (percent: number) => clamp(percent, 0, 100) / 100;
  return <span className={styles.sample} data-layer-sample="">
    <svg viewBox="0 0 196 46" aria-hidden="true">
      <rect data-sample="ground" width="196" height="46" fill={ground.land} />
      <path d="M0 36 C 50 30 90 44 196 33" fill="none" stroke={ground.water} strokeWidth="10" />
      <path d="M120 0 C 116 18 128 30 122 46" fill="none" stroke={ground.road} strokeWidth="2" />
      <path data-sample="area" d="M136 9 L172 6 L184 24 L166 38 L138 33 Z" fill={color(2)} fillOpacity={share(look.areaOpacity)} />
      <path data-sample="line" d="M62 38 C 76 16 92 30 108 8" fill="none" stroke={color(1)} strokeOpacity={share(look.lineOpacity)}
        strokeWidth={clamp(look.lineWidth, 0, LINE_MAX)} strokeLinecap="round" />
      {POINTS.map(([x, y]) => <circle key={`${x}-${y}`} data-sample="point" cx={x} cy={y} r={clamp(look.pointRadius, 0, RADIUS_MAX)}
        fill={color(0)} fillOpacity={share(look.pointOpacity)} />)}
    </svg>
  </span>;
}

/** The first ten colors of a cycle, as the palette picker's strip shows them. */
export function CycleSwatches({ palette }: { palette: string }) {
  return <span className={styles.swatches} data-swatches="" aria-hidden="true">
    {cycle(palette).slice(0, 10).map((color, index) => <i key={index} style={{ background: color }} />)}
  </span>;
}

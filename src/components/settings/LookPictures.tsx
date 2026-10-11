"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { PicturePick } from "./look-tab";
import { CursorIcon } from "@/components/ui/icons";
import { DEFAULT_CATEGORICAL, paletteByName } from "@/lib/style/palettes";
import { SAMPLE_GROUNDS } from "./basemap-grounds";
import styles from "./LookPictures.module.css";
// The pictures' tokens: each option's values keyed on the picture, beside
// the person's look on the root.
import "./look-pictures.css";

/**
 * The Appearance tab's pictures, one per option of a pick. Each shows its
 * own option (its tokens come from the pictures' stylesheet, keyed on the
 * picture) while everything else in it follows the person's look, so a
 * Harbor picture is Harbor at the person's contrast, typeface and corners.
 * Most are drawn at a logical width and scaled to their box, so corners,
 * the typeface and the controls show in them at the size they have in the
 * interface. The words in them are part of the drawing, never a name.
 */

/** The logical widths the scaled pictures are drawn at; the box is 16:10. */
const LOGICAL = { s: 190, m: 240 } as const;

/** Scale the drawing from its logical width to its box, as the box resizes. */
function useFitScale(box: React.RefObject<HTMLSpanElement | null>, width: number) {
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => {
      if (element.clientWidth) element.style.setProperty("--picture-scale", String(element.clientWidth / width));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, width]);
}

function Scaled({ pick, value, size, className, children }: {
  pick: PicturePick;
  value: string;
  size: keyof typeof LOGICAL;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLSpanElement>(null);
  useFitScale(box, LOGICAL[size]);
  return <span ref={box} className={className ? `${styles.art} ${className}` : styles.art} {...{ [`data-picture-${pick}`]: value }}>
    <span className={styles.stage} data-size={size}>{children}</span>
  </span>;
}

/** The shell in that Color: its ground and the person's Background in its
 * inks, the header card with the wordmark and the instance chip, the side
 * menu with its active item, and a card with a switch and a button. */
function ColorPicture({ value }: { value: string }) {
  return <Scaled pick="color" value={value} size="m" className={styles.colorArt}>
    <span className={styles.coHead}><b>Dezfil</b><i /></span>
    <span className={styles.coRail}><i data-on="" /><i /><i /></span>
    <span className={styles.coCard}>
      <span className={styles.coRow}><i /><span className={styles.coSwitch} /></span>
      <span className={styles.coRow}><i /><span className={styles.coButton}>Publish</span></span>
    </span>
  </Scaled>;
}

/** Two rows with their borders, their quieter words and a field. */
function ContrastPicture({ value }: { value: string }) {
  return <Scaled pick="contrast" value={value} size="m">
    <span className={styles.ctCard}>
      <span className={styles.ctRow}>
        <span className={styles.ctText}><b>Preview rows</b><small>Up to 10,000</small></span>
        <span className={styles.ctField}>1,000</span>
      </span>
      <span className={styles.ctRow}>
        <span className={styles.ctText}><b>Snap to grid</b><small>Every 8 px</small></span>
        <span className={styles.ctSwitch} />
      </span>
    </span>
  </Scaled>;
}

/** A few words in that face. */
function FontPicture({ value }: { value: string }) {
  return <Scaled pick="font" value={value} size="s">
    <span className={styles.fnCard}>
      <b className={styles.fnSample}>Ag</b>
      <span className={styles.fnName}>Flood risk 2026</span>
      <span className={styles.fnDigits}>0123456789</span>
    </span>
  </Scaled>;
}

/** A card, a field, a choice and a button in that family of corners. */
function CornersPicture({ value }: { value: string }) {
  return <Scaled pick="corners" value={value} size="m">
    <span className={styles.crCard}>
      <span className={styles.crField}>Flood risk 2026</span>
      <span className={styles.crActions}>
        <span className={styles.crSegments}><i data-on="" /><i /><i /></span>
        <span className={styles.crButton}>Save</span>
      </span>
    </span>
  </Scaled>;
}

/** The side menu beside a page, in that behavior: shut with a resting
 * pointer (it opens while the pointer rests on the card), standing open,
 * or shut with an item naming itself in a hint. */
function RailPicture({ value }: { value: string }) {
  return <Scaled pick="rail" value={value} size="m">
    <span className={styles.smPage}><i /><i /><i /></span>
    <span className={styles.smRail}>
      <span data-on=""><i /><b /></span><span><i /><b /></span><span><i /><b /></span><span><i /><b /></span>
    </span>
    {value === "hover" && <span className={styles.smPointer}><CursorIcon /></span>}
    {value === "icons" && <span className={styles.smHint}>Maps</span>}
  </Scaled>;
}

/* ---- Panels: the map under the panels. Its colours are data (a basemap's
   ground, Global Warming on the cells, the layer cycle's teal and pink on
   a line and its stops), drawn inline; the panels have none of their own. */

/** The river the cells gather along, across the picture's 240 by 150. */
const riverY = (x: number) => 19 + 0.27 * x + 10 * Math.sin(x / 26);
const round = (n: number) => Math.round(n * 10) / 10;
const RIVER = Array.from({ length: 14 }, (_, i) => -20 + i * 20).map((x, i) => `${i ? "L" : "M"}${x} ${round(riverY(x))}`).join(" ");
/** The cells: a hex grid along the river, the nearest the warmest. */
const CELLS = (() => {
  const ramp = paletteByName("global_warming", "sequential")!.colors;
  const radius = 4.5, step = Math.sqrt(3) * radius, corners = Array.from({ length: 6 }, (_, i) => (Math.PI / 180) * (60 * i - 30));
  const out: { d: string; fill: string }[] = [];
  for (let row = 0, cy = 0; cy < 150; cy += radius * 1.5, row += 1) {
    for (let cx = row % 2 ? step / 2 : 0; cx < 246; cx += step) {
      const near = 1 - Math.abs(cy - riverY(cx)) / 24;
      if (near <= 0) continue;
      const fill = ramp[Math.min(ramp.length - 1, Math.floor(near * ramp.length))];
      out.push({ d: `M${corners.map(a => `${round(cx + radius * Math.cos(a))} ${round(cy + radius * Math.sin(a))}`).join("L")}Z`, fill });
    }
  }
  return out;
})();
const MAINS = ["M12 92 L60 80 L100 88 L130 74 L170 80 L210 64 L240 68", "M128 12 L134 46 L130 74 L140 114"];
const STOPS: readonly (readonly [number, number])[] = [[60, 80], [100, 88], [134, 46], [170, 80], [210, 64]];

/** A small map in both themes: the root's theme shows one. */
function PanelsMap() {
  const cycle = paletteByName(DEFAULT_CATEGORICAL, "categorical")!.colors;
  const [teal, pink] = [cycle[0], cycle[6]];
  return <svg className={styles.pnMap} viewBox="0 0 240 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    {(["light", "dark"] as const).map(theme => {
      const ground = SAMPLE_GROUNDS[theme];
      return <g key={theme} className={theme === "light" ? styles.pnDay : styles.pnNight}>
        <rect width="240" height="150" fill={ground.land} />
        <path d="M0 128 L240 104 M86 0 L104 150" stroke={ground.road} strokeWidth="3" fill="none" />
        <path d={RIVER} stroke={ground.water} strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>;
    })}
    {CELLS.map((cell, i) => <path key={i} d={cell.d} fill={cell.fill} fillOpacity="0.78" />)}
    {MAINS.map(d => <path key={d} d={d} stroke={teal} strokeWidth="1.2" fill="none" strokeLinejoin="round" strokeLinecap="round" />)}
    {STOPS.map(([x, y]) => <circle key={`${x} ${y}`} cx={x} cy={y} r="2.2" fill={pink} />)}
  </svg>;
}

/** The header card, the side menu and a card over a small map, in that
 * style of panel: the map shows through as that style lets it. */
function PanelsPicture({ value }: { value: string }) {
  return <Scaled pick="panels" value={value} size="m">
    <PanelsMap />
    <span className={styles.pnHead}><b>Dezfil</b><i /></span>
    <span className={styles.pnRail}><i data-on="" /><i /><i /><i /><i /></span>
    <span className={styles.pnCard}><b /><i /><i /></span>
  </Scaled>;
}

/** The texture itself, under a card floating on it. */
function BackgroundPicture({ value }: { value: string }) {
  return <span className={`${styles.art} ${styles.backgroundArt}`} data-picture-background={value}>
    <span className={styles.bgCard}><i /><i /></span>
  </span>;
}

const PICTURES: Record<PicturePick, (props: { value: string }) => ReactNode> = {
  color: ColorPicture,
  contrast: ContrastPicture,
  font: FontPicture,
  background: BackgroundPicture,
  corners: CornersPicture,
  rail: RailPicture,
  panels: PanelsPicture,
};

/** The picture of one option of one pick. */
export function LookPicture({ pick, value }: { pick: PicturePick; value: string }) {
  const Picture = PICTURES[pick];
  return <Picture value={value} />;
}

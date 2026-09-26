"use client";

import { useRef, useState } from "react";
import { useSliderInteraction } from "./use-slider-interaction";
import { sliderFill } from "./rows";
import { sliderClass } from "../../ui/Slider";
import styles from "../StylePanel.module.css";

/**
 * Continuous cell size for hex bins and grid. One log-scaled track covers
 * the whole range — tens of meters to hundreds of kilometers — with live
 * preview at every position, and the readout is a typable input for users
 * who need "exactly 2.5 km". Values round to three significant digits so
 * the slider lands on friendly numbers.
 */
const TRACK_STEPS = 600;

function positionFor(km: number, min: number, max: number): number {
  const clamped = Math.min(max, Math.max(min, km));
  return Math.round((Math.log(clamped / min) / Math.log(max / min)) * TRACK_STEPS);
}

function kmAt(position: number, min: number, max: number): number {
  const km = min * Math.pow(max / min, position / TRACK_STEPS);
  return Number(km.toPrecision(3));
}

/** "460 m" below one kilometer, "1.2 km" above — matching the map. */
export function formatCellKm(km: number): string {
  const shown = km < 1 ? `${Number((km * 1000).toPrecision(3))} m` : `${Number(km.toPrecision(3))} km`;
  return shown;
}

/** Lenient size parsing: "800 m", "2.5 km", or a bare number in km. */
function parseCellKm(text: string): number | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(km|m)?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  return match[2]?.toLowerCase() === "m" ? value / 1000 : value;
}

export function CellSizeRow({
  cellKm,
  min,
  max,
  onChange,
  onPreview,
  onCommit,
  onPreviewStart,
}: {
  cellKm: number;
  min: number;
  max: number;
  onChange: (km: number) => void;
  onPreview?: (km: number) => void;
  onCommit?: (km: number) => Promise<boolean>;
  onPreviewStart?: () => void;
}) {
  const { shown, begin, preview, finish } = useSliderInteraction({
    value: cellKm,
    onChange,
    onPreview,
    onCommit,
    onPreviewStart,
  });
  const [text, setText] = useState<string | null>(null);
  const [lastShown, setLastShown] = useState(shown);
  const escapedRef = useRef(false);

  // A slider drag (or an outside update) refreshes an idle input —
  // state adjusted during render, the pattern the hooks rules endorse.
  if (shown !== lastShown) {
    setLastShown(shown);
    setText(null);
  }

  const commitText = () => {
    // Escape reverts: the blur it triggers must not commit the stale text.
    if (escapedRef.current) {
      escapedRef.current = false;
      return;
    }
    if (text === null) return;
    const parsed = parseCellKm(text);
    setText(null);
    if (parsed === null) return;
    const clamped = Number(Math.min(max, Math.max(min, parsed)).toPrecision(3));
    if (clamped === shown) return;
    preview(clamped);
    void finish();
  };

  return (
    <div className={styles.row}>
      {/* **Named, not softened**. The number is exact — it is
          simply a length on the web-mercator projection, not a distance on the
          ground, and at 52°N a 1.2 km cell covers about 730 m. "About 1.2 km"
          would keep the collision and add a false claim about precision on top
          of it, so the words say which metre they mean instead. */}
      <span className={styles.rowLabel}>Cell size (Mercator)</span>
      <input
        type="range"
        className={sliderClass}
        style={sliderFill(positionFor(shown, min, max), 0, TRACK_STEPS)}
        aria-label="Cell size in web-mercator units"
        min={0}
        max={TRACK_STEPS}
        step={1}
        value={positionFor(shown, min, max)}
        onPointerDown={begin}
        onPointerUp={() => void finish()}
        onPointerCancel={() => void finish()}
        onKeyDown={begin}
        onKeyUp={() => void finish()}
        onBlur={() => void finish()}
        onChange={(e) => preview(kmAt(Number(e.target.value), min, max))}
      />
      <input
        className={styles.num}
        aria-label="Cell size value"
        value={text ?? formatCellKm(shown)}
        onFocus={(e) => {
          setText(formatCellKm(shown));
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            escapedRef.current = true;
            setText(null);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

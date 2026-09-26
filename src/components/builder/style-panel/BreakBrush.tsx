"use client";

import { useRef, useState } from "react";
import type { QuantileFill } from "@/lib/style/style";
import { toHex } from "@/lib/style/color";
import { niceBreaks } from "@/lib/style/nice-breaks";
import { formatCompact } from "@/lib/style/legend";
import { DistributionBars } from "../Distribution";
import styles from "./BreakBrush.module.css";

/**
 * The attribute's distribution with the class boundaries as draggable
 * handles: bars colored by the class their center falls into, min/mean/max
 * header, handles clamped between their neighbors. Dragging previews
 * locally; release snaps the boundary to a nice value and persists the
 * scale as Custom exactly once.
 */
export function BreakBrush({
  paint,
  min,
  max,
  mean,
  bins,
  integer,
  disabled,
  onPaint,
  onPaintPreview,
  onPaintCommit,
}: {
  paint: QuantileFill;
  min: number;
  max: number;
  mean: number | null;
  bins: number[];
  integer: boolean;
  disabled: boolean;
  onPaint: (p: QuantileFill) => void;
  onPaintPreview?: (p: QuantileFill) => void;
  onPaintCommit?: (p: QuantileFill) => Promise<boolean>;
}) {
  const span = max - min || 1;
  const step = span / 200;
  // While dragging or settling, the draft wins over the authoritative prop.
  const [draft, setDraft] = useState<number[] | null>(null);
  const draftRef = useRef<number[] | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const split = !!onPaintPreview && !!onPaintCommit;
  const breaks = draft ?? paint.breaks;

  const colorFor = (v: number) => {
    let i = 0;
    while (i < breaks.length && v > breaks[i]) i++;
    return toHex(paint.colors[Math.min(i, paint.colors.length - 1)]);
  };

  const asCustom = (next: number[]): QuantileFill => ({
    ...paint,
    breaks: next,
    method: "custom",
    baseMethod:
      paint.method === "custom"
        ? (paint.baseMethod ?? "quantile")
        : (paint.method ?? "quantile"),
  });

  const begin = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    generationRef.current += 1;
  };

  const preview = (index: number, raw: number) => {
    begin();
    const current = draftRef.current ?? paint.breaks;
    const lo = index > 0 ? current[index - 1] + step : min;
    const hi = index < current.length - 1 ? current[index + 1] - step : max;
    const next = [...current];
    next[index] = Math.min(Math.max(raw, lo), hi);
    draftRef.current = next;
    setDraft(next);
    const nextPaint = asCustom(next);
    if (split) onPaintPreview(nextPaint);
    else onPaint(nextPaint);
  };

  const commit = async () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const generation = generationRef.current;
    const final = draftRef.current;
    if (!final) return;
    // A released boundary reads as nicely as a computed one — unless
    // snapping would merge classes; exact values win then.
    const snapped = niceBreaks(final, { integer, lo: min, hi: max });
    const unchanged =
      final.length === paint.breaks.length &&
      final.every((value, i) => value === paint.breaks[i]);
    const target = unchanged
      ? paint
      : asCustom(snapped.length === final.length ? snapped : final);
    if (split) await onPaintCommit(target);
    else onPaint(target);
    if (generation === generationRef.current && !activeRef.current) {
      draftRef.current = null;
      setDraft(null);
    }
  };

  // The strip under the bars is the scale drawn to measure: each
  // class's color spans exactly its break range, moving live with the
  // draft while a handle drags.
  const edges = [
    0,
    ...breaks.map((b) =>
      Math.min(Math.max(((b - min) / span) * 100, 0), 100),
    ),
    100,
  ];

  return (
    <div className={styles.brush}>
      <div className={styles.header} aria-hidden>
        <span>min {formatCompact(min)}</span>
        {mean !== null && <span>mean {formatCompact(mean)}</span>}
        <span>max {formatCompact(max)}</span>
      </div>
      <div className={styles.plot}>
        <DistributionBars bins={bins} from={min} to={max} colorFor={colorFor} />
      </div>
      <div className={styles.strip} aria-hidden>
        {paint.colors.map((c, i) => (
          <i
            key={i}
            style={{
              width: `${Math.max(
                (edges[Math.min(i + 1, edges.length - 1)] ?? 100) -
                  (edges[i] ?? 0),
                0,
              )}%`,
              background: toHex(c),
            }}
          />
        ))}
      </div>
      <div className={styles.track}>
        {breaks.map((b, i) => (
          <input
            key={i}
            type="range"
            className={styles.thumb}
            aria-label={`Class boundary ${i + 1}`}
            min={min}
            max={max}
            step={step}
            value={b}
            disabled={disabled}
            onPointerDown={begin}
            onChange={(e) => preview(i, Number(e.target.value))}
            onPointerUp={() => void commit()}
            onPointerCancel={() => void commit()}
            onKeyDown={begin}
            onKeyUp={() => void commit()}
            onBlur={() => void commit()}
          />
        ))}
      </div>
    </div>
  );
}

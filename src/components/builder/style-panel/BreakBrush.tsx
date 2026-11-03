"use client";

import { useRef, useState } from "react";
import type { QuantileFill } from "@/lib/style/style";
import type { ClassificationDistribution } from "@/lib/classification-distribution";
import { toHex } from "@/lib/style/color";
import { formatBreak } from "@/lib/style/class-labels";
import { formatCompact } from "@/lib/style/legend";
import { DistributionBars } from "../Distribution";
import { barValue, brushAxis, classIndex, handleLanes } from "./brush-axis";
import { customBreaks, releasedBreaks } from "./custom-breaks";
import styles from "./BreakBrush.module.css";

/** Handle positions run over this many steps of the axis. */
const STEPS = 1000;

/**
 * The distribution a classification sees, with the class boundaries as
 * draggable handles: bars coloured by the class their values fall in, a
 * min/mean/max header, and bars, colour strip and handles on the one axis
 * the statistics read answered, linear or logarithmic. Each handle is its
 * own control, clamped between its neighbours; grips that would overlap
 * stagger above and below the track. Dragging previews locally; release
 * snaps the boundary (to a whole number on whole-number data, keeping the
 * order, or staying put when none fits) and saves the scale as Custom
 * exactly once.
 */
export function BreakBrush({
  paint,
  stats,
  disabled,
  onPaint,
  onPaintPreview,
  onPaintCommit,
}: {
  paint: QuantileFill;
  /** The classification distribution, with at least one bin. */
  stats: ClassificationDistribution & { min: number; max: number };
  disabled: boolean;
  onPaint: (p: QuantileFill) => void;
  onPaintPreview?: (p: QuantileFill) => void;
  onPaintCommit?: (p: QuantileFill) => Promise<boolean>;
}) {
  const { min, max, mean, bins, edges, wholeNumbers } = stats;
  const axis = brushAxis(min, max, stats.axis);
  // While dragging or settling, the draft wins over the authoritative prop.
  const [draft, setDraft] = useState<number[] | null>(null);
  const draftRef = useRef<number[] | null>(null);
  const movedRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const split = !!onPaintPreview && !!onPaintCommit;
  const breaks = draft ?? paint.breaks;

  const classColor = (v: number) =>
    toHex(paint.colors[Math.min(classIndex(breaks, v), paint.colors.length - 1)]);
  const barColors = bins.map((_, i) =>
    classColor(barValue(edges[i], edges[i + 1], stats.axis, wholeNumbers, i === bins.length - 1)),
  );

  const asCustom = (next: number[]) => customBreaks(paint, next);

  const begin = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    generationRef.current += 1;
  };

  const preview = (index: number, step: number) => {
    begin();
    movedRef.current = index;
    const current = draftRef.current ?? paint.breaks;
    // Neighbours hold the handle a step of the axis away on either side.
    const lo = index > 0 ? axis.value(axis.position(current[index - 1]) + 1 / STEPS) : min;
    const hi = index < current.length - 1 ? axis.value(axis.position(current[index + 1]) - 1 / STEPS) : max;
    const next = [...current];
    next[index] = Math.min(Math.max(axis.value(step / STEPS), lo), hi);
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
    const released = releasedBreaks(paint.breaks, final, movedRef.current, { wholeNumbers, min, max });
    const unchanged = released.every((value, i) => value === paint.breaks[i]);
    const target = unchanged ? paint : asCustom(released);
    if (split) await onPaintCommit(target);
    else onPaint(target);
    if (generation === generationRef.current && !activeRef.current) {
      draftRef.current = null;
      movedRef.current = null;
      setDraft(null);
    }
  };

  // The strip under the bars is the scale drawn to measure: each class's
  // colour spans exactly its break range on the axis, moving live with the
  // draft while a handle drags.
  const places = breaks.map((b) => axis.position(b));
  const stops = [0, ...places, 1];
  const lanes = handleLanes(places);

  return (
    <div className={styles.brush} data-axis={stats.axis}>
      <div className={styles.header} aria-hidden>
        <span>min {formatCompact(min)}</span>
        {mean !== null && <span>mean {formatCompact(mean)}</span>}
        <span>max {formatCompact(max)}</span>
      </div>
      <div className={styles.plot}>
        <DistributionBars bins={bins} from={min} to={max} barColors={barColors} />
      </div>
      <div className={styles.strip} aria-hidden>
        {paint.colors.map((c, i) => (
          <i
            key={i}
            style={{
              width: `${Math.max(((stops[i + 1] ?? 1) - (stops[i] ?? 0)) * 100, 0)}%`,
              background: toHex(c),
            }}
          />
        ))}
      </div>
      <div className={styles.track}>
        {breaks.map((b, i) => (
          <div key={i} className={styles.lane} data-lane={lanes[i]}>
            {lanes[i] !== "mid" && (
              <i className={styles.tie} style={{ left: `${places[i] * 100}%` }} aria-hidden />
            )}
            <input
              type="range"
              className={styles.thumb}
              aria-label={`Class boundary ${i + 1}`}
              aria-valuetext={formatBreak(b)}
              min={0}
              max={STEPS}
              step={1}
              value={Math.round(places[i] * STEPS)}
              disabled={disabled}
              onPointerDown={begin}
              onChange={(e) => preview(i, Number(e.target.value))}
              onPointerUp={() => void commit()}
              onPointerCancel={() => void commit()}
              onKeyDown={begin}
              onKeyUp={() => void commit()}
              onBlur={() => void commit()}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

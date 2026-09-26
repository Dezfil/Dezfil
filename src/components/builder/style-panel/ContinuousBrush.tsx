"use client";

import { useRef, useState, type CSSProperties } from "react";
import type { ContinuousFill } from "@/lib/style/style";
import { toHex } from "@/lib/style/color";
import { formatCompact } from "@/lib/style/legend";
import { continuousPosition } from "@/lib/style/deck-style";
import { sampleRamp } from "@/lib/style/palettes";
import { DistributionBars } from "../Distribution";
import { GradientRamp } from "../../GradientRamp";
import { sliderClass } from "../../ui/Slider";
import styles from "./BreakBrush.module.css";
import { Switch } from "../../ui/Switch";
import panelStyles from "../StylePanel.module.css";
import { sliderFill } from "./rows";

/** The ramp as a CSS gradient — stops at their positions. */
export function rampGradient(paint: {
  stops: ContinuousFill["stops"];
  positions?: number[];
}): string {
  const n = paint.stops.length;
  const at = (i: number) =>
    paint.positions ? paint.positions[i] : n === 1 ? 0 : i / (n - 1);
  return `linear-gradient(90deg, ${paint.stops
    .map((c, i) => `${toHex(c)} ${(at(i) * 100).toFixed(1)}%`)
    .join(", ")})`;
}

/**
 * The continuous scale's domain tools: the attribute's distribution over
 * the full gradient, two clamp handles narrowing the effective domain, a
 * log toggle for skewed fields, and — when the paint carries a diverging
 * center — the center slider. Dragging previews locally; release
 * persists exactly once (the slider contract).
 */
export function ContinuousBrush({
  paint,
  min,
  max,
  mean,
  bins,
  disabled,
  onPaint,
  onPaintPreview,
  onPaintCommit,
}: {
  paint: ContinuousFill;
  min: number;
  max: number;
  mean: number | null;
  bins: number[];
  disabled: boolean;
  onPaint: (p: ContinuousFill) => void;
  onPaintPreview?: (p: ContinuousFill) => void;
  onPaintCommit?: (p: ContinuousFill) => Promise<boolean>;
}) {
  const [d0, d1] = paint.domain;
  const span = d1 - d0 || 1;
  const step = span / 200;
  // The narrowest clamp the handles allow — wide enough to stay readable.
  const minGap = span / 25;
  const [draft, setDraft] = useState<ContinuousFill | null>(null);
  const draftRef = useRef<ContinuousFill | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const split = !!onPaintPreview && !!onPaintCommit;
  const shown = draft ?? paint;
  const [clampLo, clampHi] = shown.clamp ?? shown.domain;

  const position = continuousPosition(shown);
  const colorFor = (v: number) =>
    toHex(sampleRamp(shown.stops, shown.positions, position(v)));

  const begin = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    generationRef.current += 1;
  };

  const preview = (next: ContinuousFill) => {
    begin();
    draftRef.current = next;
    setDraft(next);
    if (split) onPaintPreview(next);
    else onPaint(next);
  };

  const commit = async () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const generation = generationRef.current;
    const final = draftRef.current;
    if (!final) return;
    if (split) await onPaintCommit(final);
    else onPaint(final);
    if (generation === generationRef.current && !activeRef.current) {
      draftRef.current = null;
      setDraft(null);
    }
  };

  /** A clamp identical to the domain stores as none — clean JSON. */
  const withClamp = (lo: number, hi: number): ContinuousFill => {
    const next: ContinuousFill = { ...(draftRef.current ?? paint) };
    if (lo <= d0 && hi >= d1) delete next.clamp;
    else next.clamp = [Math.max(lo, d0), Math.min(hi, d1)];
    const [lo2, hi2] = next.clamp ?? next.domain;
    // Log needs a strictly positive effective domain; a clamp dragged to
    // zero or below turns it off rather than bouncing off the server.
    if (next.log && lo2 <= 0) delete next.log;
    if (next.center !== undefined) {
      next.center = Math.min(hi2, Math.max(lo2, next.center));
    }
    return next;
  };

  const previewLo = (raw: number) =>
    preview(withClamp(Math.min(raw, clampHi - minGap), clampHi));
  const previewHi = (raw: number) =>
    preview(withClamp(clampLo, Math.max(raw, clampLo + minGap)));

  const previewCenter = (raw: number) => {
    const current = draftRef.current ?? paint;
    const [lo, hi] = current.clamp ?? current.domain;
    preview({ ...current, center: Math.min(hi, Math.max(lo, raw)) });
  };

  const toggleLog = (on: boolean) => {
    const next: ContinuousFill = { ...paint };
    if (on) next.log = true;
    else delete next.log;
    onPaint(next);
  };

  const logAllowed = clampLo > 0;
  const clamped = shown.clamp !== undefined;

  return (
    <>
      <div className={styles.brush}>
        <div className={styles.header} aria-hidden>
          <span>min {formatCompact(min)}</span>
          {mean !== null && <span>mean {formatCompact(mean)}</span>}
          <span>max {formatCompact(max)}</span>
        </div>
        <div className={styles.plot}>
          <DistributionBars bins={bins} from={min} to={max} colorFor={colorFor} />
        </div>
        <GradientRamp className={styles.strip} gradient={rampGradient(shown)} />
        <div className={styles.track}>
          <input
            type="range"
            className={styles.thumb}
            aria-label="Domain clamp, low end"
            min={d0}
            max={d1}
            step={step}
            value={clampLo}
            disabled={disabled}
            onPointerDown={begin}
            onChange={(e) => previewLo(Number(e.target.value))}
            onPointerUp={() => void commit()}
            onPointerCancel={() => void commit()}
            onKeyDown={begin}
            onKeyUp={() => void commit()}
            onBlur={() => void commit()}
          />
          <input
            type="range"
            className={styles.thumb}
            aria-label="Domain clamp, high end"
            min={d0}
            max={d1}
            step={step}
            value={clampHi}
            disabled={disabled}
            onPointerDown={begin}
            onChange={(e) => previewHi(Number(e.target.value))}
            onPointerUp={() => void commit()}
            onPointerCancel={() => void commit()}
            onKeyDown={begin}
            onKeyUp={() => void commit()}
            onBlur={() => void commit()}
          />
        </div>
        {clamped && (
          <div className={styles.header} aria-hidden>
            <span>
              clamp {formatCompact(clampLo)} – {formatCompact(clampHi)} ·
              values outside take the end colors
            </span>
          </div>
        )}
      </div>

      {shown.center !== undefined && (
        <div className={panelStyles.row}>
          <span className={panelStyles.rowLabel}>Center</span>
          <input
            type="range"
            className={sliderClass}
            style={sliderFill(shown.center, clampLo, clampHi) as CSSProperties}
            aria-label="Diverging center"
            min={clampLo}
            max={clampHi}
            step={step}
            value={shown.center}
            disabled={disabled}
            onPointerDown={begin}
            onChange={(e) => previewCenter(Number(e.target.value))}
            onPointerUp={() => void commit()}
            onPointerCancel={() => void commit()}
            onKeyDown={begin}
            onKeyUp={() => void commit()}
            onBlur={() => void commit()}
          />
          <span className={panelStyles.rowValue}>
            {formatCompact(shown.center)}
          </span>
        </div>
      )}

      <label
        className={panelStyles.checkRow}
        data-hint={
          logAllowed
            ? undefined
            : "Log scale needs the effective domain above zero"
        }
        data-hint-always={logAllowed ? undefined : ""}
      >
        <Switch
          checked={shown.log === true}
          disabled={disabled || !logAllowed}
          onChange={(e) => toggleLog(e.target.checked)}
        />
        Log scale
      </label>
    </>
  );
}

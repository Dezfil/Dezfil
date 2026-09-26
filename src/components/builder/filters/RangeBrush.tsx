"use client";

import { useRef, type CSSProperties } from "react";
import { DistributionBars } from "../Distribution";
import styles from "../FilterSection.module.css";

/**
 * Two-handle brush over a numeric domain: composed from native range inputs
 * (keyboard-accessible by construction), histogram behind, commit on
 * release so dragging never floods the API.
 */
export function RangeBrush({
  from,
  to,
  sel,
  step,
  bins,
  onPreview,
  onStart,
  onCommit,
}: {
  from: number;
  to: number;
  sel: [number, number];
  /** The increment a keyboard press moves by.
   *
   *  The inputs themselves take `step="any"`: a native step snaps the
   *  *value* against the input's own `min`, so an extent whose span is not
   *  a whole multiple of the step reports a different number than it holds
   *  — the extent's own maximum, which is what an open upper bound sits on,
   *  reads as the lattice point below it. Keyboard movement is therefore
   *  handled here, by this step, which keeps both properties: exact values
   *  and increments the column derives. */
  step: number;
  bins: number[];
  onPreview: (sel: [number, number]) => void;
  onStart?: () => void;
  onCommit: () => Promise<void>;
}) {
  const span = to - from || 1;
  const pct = (v: number) => `${((v - from) / span) * 100}%`;
  /* The knob's own seat. A native range thumb travels between the track's
     edges inset by its own width, which is what `--p` reproduces — the knob
     therefore sits exactly where the native thumb used to. */
  const seat = (v: number): CSSProperties =>
    // Clamped so a value one step outside the extent — which reads as an
    // open bound — parks the knob at the track's end rather than past it.
    ({ "--p": Math.min(1, Math.max(0, (v - from) / span)) }) as CSSProperties;
  const [lo, hi] = sel;
  const activeRef = useRef(false);
  const begin = () => {
    if (activeRef.current) return;
    activeRef.current = true;
    onStart?.();
  };
  const finish = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    void onCommit();
  };

  /** Keyboard movement, by the step the caller derived. */
  const nudge = (e: React.KeyboardEvent<HTMLInputElement>, value: number) => {
    const big = span / 10;
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowUp"
        ? step
        : e.key === "ArrowLeft" || e.key === "ArrowDown"
          ? -step
          : e.key === "PageUp"
            ? big
            : e.key === "PageDown"
              ? -big
              : 0;
    if (delta === 0 && e.key !== "Home" && e.key !== "End") return null;
    e.preventDefault();
    begin();
    if (e.key === "Home") return from;
    if (e.key === "End") return to;
    return Math.min(to, Math.max(from, value + delta));
  };
  return (
    <div className={styles.brush}>
      {bins.length > 0 && (
        <DistributionBars bins={bins} from={from} to={to} highlight={[lo, hi]} />
      )}
      <div className={styles.track}>
        <div className={styles.trackBase} />
        <div
          className={styles.trackFill}
          style={{
            left: pct(lo),
            width: `${(Math.max(hi - lo, 0) / span) * 100}%`,
          }}
        />
        {/* Each handle is an invisible native input paired with the
            knob that stands in for its artwork — the checkbox's
            arrangement, adopted here so the focus ring lands on the
            handle instead of framing the whole histogram. */}
        <span className={styles.handle}>
          <input
            type="range"
            className={styles.thumb}
            aria-label="Minimum"
            min={from}
            max={to}
            step="any"
            value={lo}
            onPointerDown={begin}
            onKeyDown={(e) => {
              const next = nudge(e, lo);
              if (next !== null) onPreview([Math.min(next, hi), hi]);
            }}
            onChange={(e) => onPreview([Math.min(Number(e.target.value), hi), hi])}
            onPointerUp={finish}
            onPointerCancel={finish}
            onKeyUp={finish}
            onBlur={finish}
          />
          <span className={styles.knob} style={seat(lo)} aria-hidden />
        </span>
        <span className={styles.handle}>
          <input
            type="range"
            className={styles.thumb}
            aria-label="Maximum"
            min={from}
            max={to}
            step="any"
            value={hi}
            onPointerDown={begin}
            onKeyDown={(e) => {
              const next = nudge(e, hi);
              if (next !== null) onPreview([lo, Math.max(next, lo)]);
            }}
            onChange={(e) => onPreview([lo, Math.max(Number(e.target.value), lo)])}
            onPointerUp={finish}
            onPointerCancel={finish}
            onKeyUp={finish}
            onBlur={finish}
          />
          <span className={styles.knob} style={seat(hi)} aria-hidden />
        </span>
      </div>
    </div>
  );
}

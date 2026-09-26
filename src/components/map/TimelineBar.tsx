"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DistributionBars } from "@/components/builder/Distribution";
import { PlayIcon, PauseIcon, XIcon } from "@/components/ui/icons";
import {
  formatTimeMs,
  timeGranularity,
  type TimeWindowMs,
} from "@/lib/time";
import styles from "./TimelineBar.module.css";

/**
 * The map-docked timeline, shared by the builder and the published view:
 * the field's histogram over its full extent, a draggable window (edges
 * and the band as a whole), play/pause with adjustable speed, and a loop.
 * Live window moves go out through `onWindow` every frame — the canvas
 * applies them on the GPU; nothing else re-renders. `onSettle` fires when
 * a gesture or playback stops: the builder persists the window there, the
 * viewer ignores it.
 */

export const TIMELINE_SPEEDS = [0.5, 1, 2, 4, 8] as const;

/** Full extent sweeps in this long at speed 1. */
const BASE_SWEEP_MS = 30_000;

/** Pressing play on a full-extent window sweeps this fraction of it —
 * narrow enough that the sweep visibly moves data frame to frame. */
const DEFAULT_WINDOW_FRACTION = 20;

interface Props {
  /** Widget heading — the temporal field (and, if useful, the layer). */
  title: string;
  extent: [number, number];
  bins: number[];
  /** The settled window; open ends mean the extent edge. */
  window: TimeWindowMs;
  speed: number;
  onWindow: (win: [number, number]) => void;
  onSettle: (
    win: [number, number],
  ) => void | boolean | Promise<void | boolean>;
  onSpeed?: (speed: number) => void;
  /** Builder only: collapse the timeline back to the filter row. */
  onClose?: () => void;
}

type DragMode = "lo" | "hi" | "band";

export function TimelineBar({
  title,
  extent,
  bins,
  window: settled,
  speed,
  onWindow,
  onSettle,
  onSpeed,
  onClose,
}: Props) {
  const [lo0, hi0] = extent;
  const span = Math.max(hi0 - lo0, 1);
  const clamp = useCallback(
    (v: number) => Math.min(Math.max(v, lo0), hi0),
    [lo0, hi0],
  );
  const normalize = useCallback(
    (w: TimeWindowMs): [number, number] => [
      clamp(w[0] ?? lo0),
      clamp(w[1] ?? hi0),
    ],
    [clamp, lo0, hi0],
  );

  const onWindowRef = useRef(onWindow);
  const onSettleRef = useRef(onSettle);
  useEffect(() => {
    onWindowRef.current = onWindow;
    onSettleRef.current = onSettle;
  }, [onWindow, onSettle]);

  // The live window: state for the labels/band, a ref for the loop and
  // drags so per-frame math never reads stale renders.
  const [win, setWin] = useState<[number, number]>(() => normalize(settled));
  const winRef = useRef(win);
  const settledRef = useRef(settled);
  const revisionRef = useRef(0);
  const apply = useCallback((next: [number, number]) => {
    revisionRef.current += 1;
    winRef.current = next;
    setWin(next);
    onWindowRef.current(next);
  }, []);

  const settle = useCallback(
    (next: [number, number]) => {
      const revision = revisionRef.current;
      void (async () => {
        let accepted: void | boolean = false;
        try {
          accepted = await onSettleRef.current(next);
        } catch {
          accepted = false;
        }
        if (accepted !== false || revision !== revisionRef.current) return;
        const authoritative = normalize(settledRef.current);
        revisionRef.current += 1;
        winRef.current = authoritative;
        setWin(authoritative);
        onWindowRef.current(authoritative);
      })();
    },
    [normalize],
  );

  // A settled-window change from outside (undo, filter edit, another
  // client) resets the live window. The state is a display mirror of the
  // gesture/playback ref — syncing it when the settled prop moves is the
  // point, not an accident.
  const settledKey = `${settled[0]} ${settled[1]} ${lo0} ${hi0}`;
  useEffect(() => {
    settledRef.current = settled;
    revisionRef.current += 1;
    const next = normalize(settled);
    winRef.current = next;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWin(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey]);

  const [playing, setPlaying] = useState(false);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // The playback loop: advance the window by wall-clock time, loop at the
  // end. Runs on animation frames; every step goes through `apply`, so the
  // canvas and the labels stay in lockstep.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const [lo, hi] = winRef.current;
      let width = hi - lo;
      let next = lo;
      if (width >= span) {
        // A full-extent window has nothing to sweep — start with a slice.
        width = span / DEFAULT_WINDOW_FRACTION;
        next = lo0;
      } else {
        next = lo + dt * (span / BASE_SWEEP_MS) * speedRef.current;
        if (next + width > hi0) next = lo0; // loop
      }
      apply([next, next + width]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, span, lo0, hi0, apply]);

  const pause = useCallback(() => {
    setPlaying(false);
    settle(winRef.current);
  }, [settle]);

  // Keyboard nudges settle on a pause in the tapping, not per keystroke —
  // ten taps must not be ten writes (verification finding). Pointer
  // gestures and playback flushes clear it: their own settle covers it.
  const keySettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearKeySettle = () => {
    if (keySettle.current) clearTimeout(keySettle.current);
    keySettle.current = null;
  };
  const queueKeySettle = () => {
    clearKeySettle();
    keySettle.current = setTimeout(() => {
      keySettle.current = null;
      settle(winRef.current);
    }, 600);
  };
  const flushKeySettle = () => {
    if (!keySettle.current) return;
    clearKeySettle();
    settle(winRef.current);
  };
  useEffect(() => clearKeySettle, []);

  // Window drags: edges resize, the band slides the whole window. Commit
  // on release — dragging must never write.
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: DragMode; startX: number; at: [number, number] } | null>(null);

  const beginDrag = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (playing) setPlaying(false); // grabbing the window takes over
    clearKeySettle(); // the release's settle covers any pending nudges
    drag.current = { mode, startX: e.clientX, at: winRef.current };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const width = trackRef.current?.clientWidth;
    if (!d || !width) return;
    const dv = ((e.clientX - d.startX) / width) * span;
    const minW = span / 200;
    const [alo, ahi] = d.at;
    if (d.mode === "lo") {
      apply([Math.min(clamp(alo + dv), ahi - minW), ahi]);
    } else if (d.mode === "hi") {
      apply([alo, Math.max(clamp(ahi + dv), alo + minW)]);
    } else {
      const w = ahi - alo;
      const lo = Math.min(Math.max(alo + dv, lo0), hi0 - w);
      apply([lo, lo + w]);
    }
  };

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    settle(winRef.current);
  };

  // Arrow keys nudge a handle by 1% of the extent; the settle trails the
  // last tap (or the handle's blur), so a burst of taps writes once.
  const keyNudge = (edge: "lo" | "hi", e: React.KeyboardEvent) => {
    const dir =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const step = (dir * span) / 100;
    const [lo, hi] = winRef.current;
    const minW = span / 200;
    if (edge === "lo") apply([Math.min(clamp(lo + step), hi - minW), hi]);
    else apply([lo, Math.max(clamp(hi + step), lo + minW)]);
    queueKeySettle();
  };

  const granularity = timeGranularity(span);
  const pct = (v: number) => `${((v - lo0) / span) * 100}%`;
  const widthPct = (w: number) => `${(w / span) * 100}%`;
  const speeds = TIMELINE_SPEEDS as readonly number[];
  const nextSpeed = () =>
    speeds[(speeds.indexOf(speed) + 1) % speeds.length] ?? 1;

  // Collapsing mid-play (or mid-tap-burst) settles the window first.
  const close = () => {
    if (playing) {
      setPlaying(false);
      clearKeySettle();
      settle(winRef.current);
    } else {
      flushKeySettle();
    }
    onClose?.();
  };

  return (
    <div className={styles.bar} data-testid="timeline">
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        <span className={styles.readout} data-testid="timeline-window">
          {formatTimeMs(win[0], granularity)} – {formatTimeMs(win[1], granularity)}
        </span>
        {onClose && (
          <button
            className={styles.iconBtn}
            onClick={close}
            aria-label="Collapse timeline"
            data-hint="Collapse timeline"
          >
            <XIcon />
          </button>
        )}
      </div>
      <div className={styles.body}>
        <button
          className={styles.playBtn}
          onClick={() => {
            if (playing) {
              pause();
            } else {
              clearKeySettle(); // the pause's settle will cover it
              setPlaying(true);
            }
          }}
          aria-label={playing ? "Pause" : "Play"}
          data-hint={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          className={styles.speedBtn}
          onClick={() => onSpeed?.(nextSpeed())}
          aria-label="Playback speed"
          data-hint="Playback speed"
        >
          {speed}×
        </button>
        <div
          className={styles.track}
          ref={trackRef}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className={styles.histFill}>
            <DistributionBars bins={bins} from={lo0} to={hi0} highlight={win} />
          </div>
          <div className={styles.baseline} />
          <div
            className={styles.band}
            style={{ left: pct(win[0]), width: widthPct(win[1] - win[0]) }}
            onPointerDown={(e) => beginDrag("band", e)}
          />
          <div
            className={styles.handle}
            style={{ left: pct(win[0]) }}
            onPointerDown={(e) => beginDrag("lo", e)}
            onKeyDown={(e) => keyNudge("lo", e)}
            onBlur={flushKeySettle}
            role="slider"
            tabIndex={0}
            aria-label="Window start"
            aria-valuemin={lo0}
            aria-valuemax={hi0}
            aria-valuenow={win[0]}
            aria-valuetext={formatTimeMs(win[0], granularity)}
          />
          <div
            className={styles.handle}
            style={{ left: pct(win[1]) }}
            onPointerDown={(e) => beginDrag("hi", e)}
            onKeyDown={(e) => keyNudge("hi", e)}
            onBlur={flushKeySettle}
            role="slider"
            tabIndex={0}
            aria-label="Window end"
            aria-valuemin={lo0}
            aria-valuemax={hi0}
            aria-valuenow={win[1]}
            aria-valuetext={formatTimeMs(win[1], granularity)}
          />
        </div>
      </div>
      <div className={styles.extent}>
        <span>{formatTimeMs(lo0, granularity)}</span>
        <span>{formatTimeMs(hi0, granularity)}</span>
      </div>
    </div>
  );
}

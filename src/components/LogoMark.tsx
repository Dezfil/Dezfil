"use client";

import { useEffect, useRef } from "react";
import { BANDS, MARK_D, SMALL_D, SUMMIT, shimmerBands } from "./logo-mark-geometry";
import styles from "./LogoMark.module.css";

export interface LogoMarkProps {
  /** The box in px. Default 24. Under 24 px it draws the small version: no middle ring, a slightly larger centre. */
  size?: number;
  /** "none" (default): the still icon. "shimmer": the contours waver like water, for waiting. */
  motion?: "none" | "shimmer";
  /** Shimmer only: how far the contours move. 1 is the reviewed strength. */
  intensity?: number;
  /** Shimmer only: time scale. 1 is the reviewed pace. */
  speed?: number;
  /** The accessible name. Default "Dezfil", or "Loading" while it shimmers. */
  label?: string;
  /** "accent" (default) inks it in the theme's accent; "current" follows the text colour, for a filled tile. */
  tone?: "accent" | "current";
}

/** The centre grows by this much around the summit in the small version. */
const SMALL_GROW = `translate(${(-0.3 * SUMMIT[0]).toFixed(2)} ${(-0.3 * SUMMIT[1]).toFixed(2)}) scale(1.3)`;

/**
 * The Dezfil icon, the contour D. It is the favicon, the app icon and,
 * shimmering, the sign that Dezfil is working, always beside words that
 * say what. It never sits next to the word "Dezfil": the logo is the word.
 *
 * The shimmer is drawn live every frame, eases in from the still icon over
 * about a second, pauses while off screen and stays still under reduced
 * motion. Do not spin it or wrap it in another animation.
 */
export function LogoMark({ size = 24, motion = "none", intensity = 1, speed = 1, label, tone = "accent" }: LogoMarkProps) {
  const ref = useRef<SVGSVGElement>(null);
  const knobs = useRef({ intensity, speed });
  useEffect(() => { knobs.current = { intensity, speed }; }, [intensity, speed]);
  const moving = motion === "shimmer";

  useEffect(() => {
    const el = ref.current;
    // Without a frame clock (a server or a test host) the bands stay still.
    if (!el || !moving || typeof requestAnimationFrame !== "function") return;
    const paths = Array.from(el.querySelectorAll("path"));
    const draw = (d: readonly string[]) => paths.forEach((p, i) => p.setAttribute("d", d[i]));
    const reduce = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let raf = 0;
    let last: number | null = null;
    let t = 0;
    let age = 0;
    let seen = true;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!seen) return;
      t += dt * knobs.current.speed;
      age += dt;
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, age / 1.2));
      draw(shimmerBands(t, knobs.current.intensity * ease));
    };
    const start = () => {
      cancelAnimationFrame(raf);
      last = null;
      t = 0;
      age = 0;
      if (reduce?.matches) { draw(BANDS); return; }
      raf = requestAnimationFrame(tick);
    };
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { seen = entries.some((e) => e.isIntersecting); })
      : null;
    io?.observe(el);
    reduce?.addEventListener?.("change", start);
    start();
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
      reduce?.removeEventListener?.("change", start);
    };
  }, [moving]);

  const small = size < 24;
  return (
    <svg
      ref={ref}
      className={styles.mark}
      data-tone={tone}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={label ?? (moving ? "Loading" : "Dezfil")}
    >
      {moving
        ? BANDS.map((d, i) => (
            <path
              key={i}
              d={d}
              display={small && i === 1 ? "none" : undefined}
              transform={small && i === 2 ? SMALL_GROW : undefined}
            />
          ))
        : <path d={small ? SMALL_D : MARK_D} />}
    </svg>
  );
}

export default LogoMark;

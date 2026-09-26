"use client";

import type { ReactNode } from "react";
import styles from "./Status.module.css";

/** Work in progress, said out loud as well as drawn.
 *
 * Upload drew a filling bar and a percentage in plain divs: visible, and
 * invisible to anything that is not a pair of eyes. A determinate
 * bar carries its value; indeterminate work says that it is indeterminate.
 *
 * Deliberately not a live region: a progress bar that announced every tick
 * would talk over the page. The surrounding surface announces the terminal
 * states — success and failure — once. */
export function Progress({
  label,
  value,
  className,
}: {
  /** Names the work, for assistive tech. */
  label: string;
  /** 0–1 when known; omit for indeterminate work. */
  value?: number;
  className?: string;
}) {
  const pct = value === undefined ? undefined : Math.round(value * 100);
  return (
    <div
      className={className ? `${styles.track} ${className}` : styles.track}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={pct === undefined ? "In progress" : `${pct}%`}
    >
      <div
        className={styles.bar}
        data-indeterminate={pct === undefined || undefined}
        style={pct === undefined ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/** A state indicator whose meaning is text, not a coloured shape and a
 * title attribute on an empty element. */
export function StatusDot({
  state,
  tone,
  className,
}: {
  state: string;
  tone?: "live" | "quiet";
  className?: string;
}) {
  return (
    <span
      className={className ? `${styles.dot} ${className}` : styles.dot}
      data-live={tone === "live" || undefined}
    >
      <span className={styles.dotText}>{state}</span>
    </span>
  );
}

/** A one-line status the page can announce once when it changes. */
export function StatusLine({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={className} role="status">
      {children}
    </span>
  );
}

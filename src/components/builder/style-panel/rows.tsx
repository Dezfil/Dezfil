"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { RgbaColor } from "@/lib/style/style";
import { toHex, fromHex } from "@/lib/style/color";
import { formatBreak } from "@/lib/style/legend";
import { useSliderInteraction } from "./use-slider-interaction";
import { sliderClass } from "../../ui/Slider";
import { UnsavedField } from "../UnsavedFields";
import styles from "../StylePanel.module.css";

/** Boundaries read exactly like the legend does — the break formatter,
 * shared product-wide: exact with grouping, exponents on micro
 * magnitudes. */
export function compactNumber(n: number): string {
  return formatBreak(n);
}

/** Where the kelp fill ends on the slider track — WebKit
 * cannot read the thumb position, so the row hands it over. */
export function sliderFill(
  value: number,
  min: number,
  max: number,
): CSSProperties {
  const pct = ((value - min) / (max - min || 1)) * 100;
  return { "--fill": `${Math.min(Math.max(pct, 0), 100)}%` } as CSSProperties;
}

/**
 * One class boundary (manual breaks). Commits on blur/Enter when actually
 * edited; the server enforces ascending order and explains rejections, so
 * this stays a plain input.
 */
export function BreakInput({
  value,
  disabled,
  onCommit,
  name,
}: {
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
  /** The accessible name — positional, since boundaries repeat. */
  name: string;
}) {
  const shown = compactNumber(value);
  const [text, setText] = useState(shown);
  const commit = () => {
    if (text === shown) return;
    // The display format is enterable as-is: commas strip, exponents parse.
    const v = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(v)) {
      setText(shown);
      return;
    }
    onCommit(v);
  };
  return (
    <input
      className={styles.breakInput}
      value={text}
      inputMode="decimal"
      disabled={disabled}
      aria-label={name}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/**
 * A labelled select row: the row label is a visual fragment ("of",
 * "Show"), so the accessible name is a required, specific prop — the
 * association is structural, not per-site discipline.
 */
export function SelectRow({
  label,
  name,
  value,
  disabled,
  onChange,
  children,
}: {
  label: ReactNode;
  /** The accessible name — specific, because row labels repeat. */
  name: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}{typeof label === "string" && <UnsavedField label={label} />}</span>
      <select
        className={styles.select}
        aria-label={name}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

export function ColorRow({
  label,
  color,
  onChange,
  name,
}: {
  label: string;
  color: RgbaColor;
  onChange: (c: RgbaColor) => void;
  /** The accessible name where the visible label repeats
   *  ("Color") — defaults to the label for already-distinct rows. */
  name?: string;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}{typeof label === "string" && <UnsavedField label={label} />}</span>
      <input
        type="color"
        className={styles.color}
        aria-label={name ?? label}
        value={toHex(color)}
        onChange={(e) => onChange(fromHex(e.target.value, color.a))}
      />
    </div>
  );
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onPreview,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** Optional direct-manipulation split. When both callbacks
   * are present, moves preview locally and release commits exactly once. */
  onPreview?: (v: number) => void;
  onCommit?: (v: number) => Promise<boolean>;
}) {
  const { shown, begin, preview, finish } = useSliderInteraction({
    value,
    onChange,
    onPreview,
    onCommit,
  });
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}{typeof label === "string" && <UnsavedField label={label} />}</span>
      <input
        type="range"
        className={sliderClass}
        style={sliderFill(shown, min, max)}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={shown}
        onPointerDown={begin}
        onPointerUp={() => void finish()}
        onPointerCancel={() => void finish()}
        onKeyDown={begin}
        onKeyUp={() => void finish()}
        onBlur={() => void finish()}
        onChange={(e) => preview(Number(e.target.value))}
      />
      <span className={styles.rowValue}>{shown}</span>
    </div>
  );
}

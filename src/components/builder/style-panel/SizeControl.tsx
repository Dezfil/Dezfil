"use client";

import type { SizeScale } from "@/lib/style/style";
import type { LayerField } from "@/lib/layer-service";
import { SliderRow } from "./rows";
import { UnsavedField } from "../UnsavedFields";
import styles from "../StylePanel.module.css";

/**
 * One size channel: a fixed value, or an attribute driving it between a
 * min→max pixel range. The domain resolves server-side when the attribute
 * is picked; range edits keep the resolved domain.
 */
export function SizeControl({
  label,
  fixed,
  fixedMin,
  fixedMax,
  fixedStep,
  rangeCap,
  scale,
  fields,
  disabled,
  defaultRange,
  resolveScale,
  onFixed,
  onFixedPreview,
  onFixedCommit,
  onScale,
}: {
  label: string;
  fixed: number;
  fixedMin: number;
  fixedMax: number;
  fixedStep: number;
  /** Upper bound of the range inputs (px) — a practical UI cap. */
  rangeCap: number;
  scale?: SizeScale;
  fields: LayerField[];
  disabled: boolean;
  defaultRange: [number, number];
  resolveScale: (
    attribute: string,
    range: [number, number],
  ) => Promise<SizeScale | null>;
  onFixed: (v: number) => void;
  onFixedPreview?: (v: number) => void;
  onFixedCommit?: (v: number) => Promise<boolean>;
  onScale: (s: SizeScale) => void;
}) {
  const changeAttribute = (value: string) => {
    if (value === "none") {
      onFixed(fixed);
      return;
    }
    void resolveScale(value, scale?.range ?? defaultRange).then(
      (s) => s && onScale(s),
    );
  };

  const changeRange = (index: 0 | 1, value: number) => {
    if (!scale || !Number.isFinite(value)) return;
    const range: [number, number] = [...scale.range];
    range[index] = Math.min(Math.max(value, 0), rangeCap);
    if (range[0] > range[1]) range[index === 0 ? 1 : 0] = range[index];
    onScale({ ...scale, range });
  };

  // The size itself leads: the slider — or, when a field drives it, the
  // pixel range — under the channel's own name; the fixed-vs-field
  // choice reads as a plain "Scale by" row beneath.
  return (
    <>
      {scale ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{label}{typeof label === "string" && <UnsavedField label={label} />}</span>
          <input
            type="number"
            className={styles.num}
            min={0}
            max={rangeCap}
            step={fixedStep}
            value={scale.range[0]}
            disabled={disabled}
            aria-label={`${label} minimum`}
            onChange={(e) => changeRange(0, Number(e.target.value))}
          />
          <span className={styles.rangeSep}>–</span>
          <input
            type="number"
            className={styles.num}
            min={0}
            max={rangeCap}
            step={fixedStep}
            value={scale.range[1]}
            disabled={disabled}
            aria-label={`${label} maximum`}
            onChange={(e) => changeRange(1, Number(e.target.value))}
          />
          <span className={styles.rowValue}>px</span>
        </div>
      ) : (
        <SliderRow
          label={label}
          value={fixed}
          min={fixedMin}
          max={fixedMax}
          step={fixedStep}
          onChange={onFixed}
          onPreview={onFixedPreview}
          onCommit={onFixedCommit}
        />
      )}
      <div className={styles.row}>
        <span className={styles.rowLabel}>Scale by</span>
        <select
          className={styles.select}
          value={scale?.attribute ?? "none"}
          disabled={disabled}
          aria-label={`${label} scale attribute`}
          onChange={(e) => changeAttribute(e.target.value)}
        >
          <option value="none">None</option>
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

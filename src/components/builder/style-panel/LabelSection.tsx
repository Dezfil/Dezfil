"use client";

import { useState } from "react";
import {
  LABEL_ANCHORS,
  LABEL_CASES,
  LABEL_CAP,
  LABEL_HALO_WIDTH_MAX,
  LABEL_MAX_CHARS,
  LABEL_OFFSET_MAX,
  LABEL_ROTATION_MAX,
  type LabelStyle,
  type LayerStyle,
} from "@/lib/style/style";
import { ColorRow, SliderRow } from "./rows";
import { SwitchRow } from "../../ui/Switch";
import styles from "../StylePanel.module.css";
import own from "./LabelSection.module.css";

/** The renderer-settled label count for the section's honest line
 * `approximate` marks automatic mode's pre-collision X. */
export interface LabelCount {
  shown: number;
  total: number;
  approximate: boolean;
}

/**
 * The Label section's contents (extracted from StylePanel as at-touch
 * slice). Panel shape B: Text, Size, Color, Halo width, Halo color stay
 * visible; the rest sits behind one closed "More" disclosure; thinning
 * (automatic mode) adds the density slider, an advanced disclosure with
 * zoom floor and priority + cap, and the count line. Tiled layers are
 * exempt from thinning and say so.
 */
export function LabelSection({
  label,
  aggregated,
  tiled,
  stylingFields,
  numericFields,
  count,
  setCellLabels,
  setLabelAttribute,
  patch,
  onStylePreview,
  onStyleCommit,
}: {
  label: LabelStyle | undefined;
  aggregated: boolean;
  tiled: boolean;
  stylingFields: { name: string }[];
  numericFields: { name: string }[];
  count: LabelCount | null;
  setCellLabels: (on: boolean) => void;
  setLabelAttribute: (attribute: string) => void;
  patch: (partial: Partial<LayerStyle>) => void;
  onStylePreview?: (partial: Partial<LayerStyle>) => void;
  onStyleCommit?: (partial: Partial<LayerStyle>) => Promise<boolean>;
}) {
  const [more, setMore] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const set = (partial: Partial<LabelStyle>) =>
    label && patch({ label: { ...label, ...partial } });

  const mappedHandlers = (
    key:
      | "size"
      | "haloWidth"
      | "density"
      | "offsetX"
      | "offsetY"
      | "rotation"
      | "maxChars"
      | "zoomFloor"
      | "cap",
    map: (v: number) => number | null = (v) => v,
  ) => ({
    onChange: (value: number) => {
      set({ [key]: map(value) });
    },
    onPreview: onStylePreview
      ? (value: number) => {
          if (label)
            onStylePreview({ label: { ...label, [key]: map(value) } });
        }
      : undefined,
    onCommit: onStyleCommit
      ? (value: number) =>
          label
            ? onStyleCommit({ label: { ...label, [key]: map(value) } })
            : Promise.resolve(false)
      : undefined,
  });
  const sliderHandlers = mappedHandlers;

  return (
    <>
      {aggregated ? (
        <SwitchRow
          className={styles.checkRow}
          checked={label !== undefined}
          onChange={(e) => setCellLabels(e.target.checked)}
          label="Cell values as labels"
        />
      ) : (
        <div className={styles.row}>
          <span className={styles.rowLabel}>Text</span>
          <select
            className={styles.select}
            aria-label="Label text"
            value={label?.attribute ?? ""}
            onChange={(e) => setLabelAttribute(e.target.value)}
          >
            <option value="">None</option>
            {stylingFields.map((f) => (
              <option key={f.name} value={f.name}>
                by {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {label && (
        <>
          <SliderRow
            label="Size"
            value={label.size}
            min={6}
            max={48}
            step={1}
            {...sliderHandlers("size")}
          />
          <ColorRow
            label="Color"
            name="Label color"
            color={label.color}
            onChange={(color) => set({ color })}
          />
          <SliderRow
            label="Halo width"
            value={label.haloWidth}
            min={0}
            max={LABEL_HALO_WIDTH_MAX}
            step={0.05}
            {...sliderHandlers("haloWidth")}
          />
          <ColorRow
            label="Halo color"
            name="Label halo color"
            color={label.haloColor}
            onChange={(haloColor) => set({ haloColor })}
          />

          <button
            type="button"
            className={own.reveal}
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            {more ? "Less" : "More"}
          </button>
          {more && (
            <>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Weight</span>
                <select
                  className={styles.select}
                  aria-label="Label weight"
                  value={label.weight ?? "normal"}
                  onChange={(e) =>
                    set({ weight: e.target.value as LabelStyle["weight"] })
                  }
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                </select>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Anchor</span>
                <select
                  className={styles.select}
                  aria-label="Label anchor"
                  value={label.anchor ?? "center"}
                  onChange={(e) =>
                    set({ anchor: e.target.value as LabelStyle["anchor"] })
                  }
                >
                  {LABEL_ANCHORS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <SliderRow
                label="Offset x"
                value={label.offsetX ?? 0}
                min={-LABEL_OFFSET_MAX}
                max={LABEL_OFFSET_MAX}
                step={1}
                {...sliderHandlers("offsetX")}
              />
              <SliderRow
                label="Offset y"
                value={label.offsetY ?? 0}
                min={-LABEL_OFFSET_MAX}
                max={LABEL_OFFSET_MAX}
                step={1}
                {...sliderHandlers("offsetY")}
              />
              <SliderRow
                label="Rotation"
                value={label.rotation ?? 0}
                min={-LABEL_ROTATION_MAX}
                max={LABEL_ROTATION_MAX}
                step={5}
                {...sliderHandlers("rotation")}
              />
              <div className={styles.row}>
                <span className={styles.rowLabel}>Case</span>
                <select
                  className={styles.select}
                  aria-label="Label case"
                  value={label.textCase ?? "as-is"}
                  onChange={(e) =>
                    set({
                      textCase: e.target.value as LabelStyle["textCase"],
                    })
                  }
                >
                  {LABEL_CASES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              {/* The off-notch sits one past the valid maximum, so 80
                  itself is authorable (overloading the
                  endpoint made it unreachable). */}
              <SliderRow
                label="Max characters"
                value={label.maxChars ?? LABEL_MAX_CHARS.max + 1}
                min={LABEL_MAX_CHARS.min}
                max={LABEL_MAX_CHARS.max + 1}
                step={1}
                {...mappedHandlers("maxChars", (v) =>
                  v > LABEL_MAX_CHARS.max ? null : v,
                )}
              />
            </>
          )}

          {/* Thinning (automatic mode) — tiled is exempt. */}
          {tiled ? (
            <p className={own.note}>Labels are not thinned on tiled layers.</p>
          ) : (
            <>
              <SliderRow
                label="Label density"
                value={label.density ?? 0.5}
                min={0}
                max={1}
                step={0.05}
                {...sliderHandlers("density")}
              />
              <button
                type="button"
                className={own.reveal}
                aria-expanded={advanced}
                onClick={() => setAdvanced((a) => !a)}
              >
                {advanced ? "Fewer thinning options" : "Thinning options"}
              </button>
              {advanced && (
                <>
                  <SliderRow
                    label="From zoom"
                    value={label.zoomFloor ?? 0}
                    min={0}
                    max={24}
                    step={1}
                    {...mappedHandlers("zoomFloor", (v) =>
                      v <= 0 ? null : v,
                    )}
                  />
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Priority</span>
                    <select
                      className={styles.select}
                      aria-label="Label priority column"
                      value={label.priorityField ?? ""}
                      onChange={(e) =>
                        set({ priorityField: e.target.value || null })
                      }
                    >
                      <option value="">Feature order</option>
                      {numericFields.map((f) => (
                        <option key={f.name} value={f.name}>
                          by {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Steps of 50 anchored AT 50 (1 was unreachable-with-50
                      granularity the smoke flagged); the off-notch sits
                      one step past the valid maximum. */}
                  <SliderRow
                    label="Cap"
                    value={label.cap ?? LABEL_CAP.max + 50}
                    min={50}
                    max={LABEL_CAP.max + 50}
                    step={50}
                    {...mappedHandlers("cap", (v) =>
                      v > LABEL_CAP.max ? null : v,
                    )}
                  />
                </>
              )}
              {count && (
                <p className={own.note} data-count>
                  {count.approximate
                    ? `Showing up to ${count.shown.toLocaleString()} of ${count.total.toLocaleString()} labels · collisions thinned to fit`
                    : `Showing ${count.shown.toLocaleString()} of ${count.total.toLocaleString()} labels`}
                </p>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

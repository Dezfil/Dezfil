"use client";

import type { FillPaint, RgbaColor } from "@/lib/style/style";
import { toHex, fromHex } from "@/lib/style/color";
import { classLabels } from "@/lib/style/class-labels";
import type { LegendChannel } from "@/lib/style/legend";
import { BreakInput } from "./rows";
import styles from "../StylePanel.module.css";

/**
 * A channel's class rows in the Style panel: one per legend entry, its
 * colour editable in place and, on a classed paint, its upper boundary
 * editable where the legend's text names it. The rows read the same
 * derivation the legend does, so the two never disagree; any palette-level
 * action recomputes and replaces these hand edits.
 */
export function ClassRows({
  paint,
  legend,
  channel,
  custom,
  disabled,
  onPaint,
}: {
  paint: FillPaint;
  legend: LegendChannel;
  /** "Fill" or "Outline": the rows' accessible names carry it. */
  channel: string;
  /** The scale's boundaries are hand-edited. */
  custom: boolean;
  disabled: boolean;
  onPaint: (p: FillPaint) => void;
}) {
  const labels = paint.type === "quantile" ? classLabels(paint) : null;

  // "custom" marks the palette as hand-edited.
  const editColor = (index: number, color: RgbaColor) => {
    if (paint.type === "quantile") {
      const colors = paint.colors.map((c, i) => (i === index ? color : c));
      onPaint({ ...paint, colors, palette: "custom" });
    } else if (paint.type === "categorical") {
      if (index < paint.map.length) {
        const map = paint.map.map((m, i) => (i === index ? { ...m, color } : m));
        onPaint({ ...paint, map, palette: "custom" });
      } else {
        onPaint({ ...paint, other: color, palette: "custom" });
      }
    }
  };

  const editBreak = (index: number, value: number) => {
    if (paint.type !== "quantile") return;
    // Order is enforced server-side with an explanatory rejection. A hand
    // edit makes the scale Custom, remembering the named method it came
    // from so a class-count change can recompute.
    const breaks = paint.breaks.map((b, i) => (i === index ? value : b));
    onPaint({
      ...paint,
      breaks,
      method: "custom",
      baseMethod:
        paint.method === "custom"
          ? (paint.baseMethod ?? "quantile")
          : (paint.method ?? "quantile"),
    });
  };

  return (
    <div className={styles.legendPreview}>
      {legend.entries.map((e, i) => {
        const lead = labels?.[i]?.lead;
        return (
          <div key={i} className={styles.legendRow}>
            <input
              type="color"
              className={styles.legendSwatchInput}
              title="Edit this class color"
              aria-label={`${channel} class ${i + 1} color`}
              value={toHex(e.color)}
              disabled={disabled}
              onChange={(ev) => editColor(i, fromHex(ev.target.value, e.color.a))}
            />
            {paint.type === "quantile" && lead !== undefined ? (
              <span className={styles.legendLabel}>
                {lead ? `${lead} ` : null}
                <BreakInput
                  key={`${i}:${paint.breaks[i]}`}
                  value={paint.breaks[i]}
                  disabled={disabled}
                  name={`${channel} class boundary ${i + 1}`}
                  onCommit={(v) => editBreak(i, v)}
                />
              </span>
            ) : (
              <span className={styles.legendLabel}>{e.label}</span>
            )}
          </div>
        );
      })}
      <p className={styles.editHint}>
        {custom
          ? "Custom boundaries: palettes just recolor; picking a " +
            "method or changing steps recomputes."
          : "Click a color or boundary to edit it."}
      </p>
    </div>
  );
}

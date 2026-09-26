"use client";

import { useEffect, useState } from "react";
import type { FillPaint, RgbaColor } from "@/lib/style/style";
import type { FieldStats, LayerField } from "@/lib/layer-service";
import type { ClassifyMethod } from "@/lib/style/classify";
import { toHex, fromHex } from "@/lib/style/color";
import { paintLegend } from "@/lib/style/legend";
import { sequentialColors } from "@/lib/style/palettes";
import { PaletteControl } from "../PaletteControl";
import { BreakBrush } from "./BreakBrush";
import { ContinuousBrush } from "./ContinuousBrush";
import { BreakInput, ColorRow, SelectRow, compactNumber } from "./rows";
import styles from "../StylePanel.module.css";

export interface ClassifyRequest {
  attribute: string;
  method: ClassifyMethod;
  palette?: string;
  classes?: number;
  reversed?: boolean;
}

/** The Fill/Outline panel's read-time projection of a stored paint. Keeping
 * this pure makes opening a data-driven channel an inspection operation;
 * classification remains behind the gesture handlers below. */
export function paintControlsOpenState(
  paint: FillPaint,
  fields: LayerField[],
) {
  const rampAttribute =
    paint.type === "quantile" || paint.type === "continuous"
      ? paint.attribute
      : null;
  const dataDriven = paint.type !== "constant";
  const attribute = dataDriven ? paint.attribute : null;
  const continuous = paint.type === "continuous";
  const method: ClassifyMethod | "custom" =
    paint.type === "quantile"
      ? (paint.method ?? "quantile")
      : continuous
        ? "continuous"
        : "categorical";
  /** The named method behind the scale, itself or what Custom derived from;
   * recomputes fall back to quantile. */
  const namedMethod: ClassifyMethod =
    paint.type === "quantile"
      ? paint.method === "custom"
        ? (paint.baseMethod ?? "quantile")
        : (paint.method ?? "quantile")
      : "categorical";
  const palette = dataDriven ? paint.palette : null;
  const reversed = dataDriven && paint.reversed === true;
  const classes =
    paint.type === "quantile"
      ? (paint.classes ?? paint.colors.length)
      : undefined;
  const attributeField = fields.find((field) => field.name === attribute);
  const paletteKind: "categorical" | "sequential" =
    method === "categorical" ? "categorical" : "sequential";
  const legend = paintLegend(paint);
  const currentHexes =
    paint.type === "quantile"
      ? paint.colors.map((color) => toHex(color))
      : paint.type === "continuous"
        ? paint.stops.map((color) => toHex(color))
        : paint.type === "categorical"
          ? paint.map.map((entry) => toHex(entry.color))
          : [];

  return {
    rampAttribute,
    dataDriven,
    attribute,
    continuous,
    method,
    namedMethod,
    palette,
    reversed,
    classes,
    attributeField,
    paletteKind,
    legend,
    currentHexes,
  };
}

/**
 * The "based on" controls for one color channel — fill or outline share
 * them: attribute, method (numeric ramps get natural breaks), class
 * count, palette, reverse, and the channel's class preview. A constant
 * paint shows just its color.
 */
export function PaintControls({
  paint,
  fields,
  disabled,
  channel,
  constantFallback,
  classify,
  fetchStats,
  onPaint,
  onPaintPreview,
  onPaintCommit,
}: {
  paint: FillPaint;
  fields: LayerField[];
  disabled: boolean;
  /** "Fill" or "Outline" — the controls repeat per channel, so their
   *  accessible names carry it. */
  channel: string;
  /** Color shown/kept when switching back to a single color. */
  constantFallback: RgbaColor;
  classify: (req: ClassifyRequest) => Promise<FillPaint | null>;
  /** The attribute's stats — extent, mean, distribution. */
  fetchStats: (attribute: string) => Promise<FieldStats | null>;
  onPaint: (p: FillPaint) => void;
  onPaintPreview?: (p: FillPaint) => void;
  onPaintCommit?: (p: FillPaint) => Promise<boolean>;
}) {
  const {
    rampAttribute,
    dataDriven,
    attribute,
    continuous,
    method,
    namedMethod,
    palette,
    reversed,
    classes,
    attributeField,
    paletteKind,
    legend,
    currentHexes,
  } = paintControlsOpenState(paint, fields);
  // The ramp's distribution, refetched when the source moves. Keyed by
  // attribute so a stale distribution never renders for the wrong column
  // while the fresh one is in flight.
  const [statsFor, setStatsFor] = useState<{
    attribute: string;
    stats: FieldStats;
  } | null>(null);
  useEffect(() => {
    if (!rampAttribute) return;
    let cancelled = false;
    void fetchStats(rampAttribute).then((s) => {
      if (!cancelled && s) setStatsFor({ attribute: rampAttribute, stats: s });
    });
    return () => {
      cancelled = true;
    };
  }, [rampAttribute, fetchStats]);
  const stats =
    statsFor && statsFor.attribute === rampAttribute ? statsFor.stats : null;

  // A palette that no longer resolves (a deleted custom palette id) must
  // not dead-end the controls: retry once without it, falling back to the
  // default ramp instead of freezing on repeated rejections.
  const classifyWithFallback = async (
    req: ClassifyRequest,
  ): Promise<FillPaint | null> => {
    const p = await classify(req);
    if (p || req.palette === undefined) return p;
    return classify({ ...req, palette: undefined });
  };

  const apply = (req: ClassifyRequest) =>
    void classifyWithFallback(req).then((p) => p && onPaint(p));

  // A palette-level change on a continuous scale keeps the domain tools:
  // same attribute over the same effective query means the same domain, so
  // clamp and log survive; the center follows the fresh paint's offer,
  // preferring the user's value when both have one.
  const applyContinuous = (req: ClassifyRequest) =>
    void classifyWithFallback(req).then((p) => {
      if (!p) return;
      if (
        p.type === "continuous" &&
        paint.type === "continuous" &&
        p.attribute === paint.attribute &&
        p.domain[0] === paint.domain[0] &&
        p.domain[1] === paint.domain[1]
      ) {
        const merged = { ...p };
        if (paint.clamp) merged.clamp = paint.clamp;
        if (paint.log && (merged.clamp ?? merged.domain)[0] > 0) {
          merged.log = true;
        }
        if (merged.center !== undefined && paint.center !== undefined) {
          const [lo, hi] = merged.clamp ?? merged.domain;
          merged.center = Math.min(hi, Math.max(lo, paint.center));
        }
        onPaint(merged);
      } else {
        onPaint(p);
      }
    });

  /** The Scale switch: classified is exactly today's behavior,
   * continuous re-resolves the same attribute as an unclassed ramp. */
  const changeScale = (next: "classified" | "continuous") => {
    if (!attribute) return;
    if (next === "continuous" && paint.type !== "continuous") {
      apply({
        attribute,
        method: "continuous",
        palette:
          paint.type === "quantile" && palette !== "custom"
            ? (palette ?? undefined)
            : undefined,
        reversed,
      });
    } else if (next === "classified" && paint.type === "continuous") {
      apply({
        attribute,
        method: "quantile",
        palette: palette ?? undefined,
        classes: 5,
        reversed,
      });
    }
  };

  const changeAttribute = (value: string) => {
    if (value === "constant") {
      onPaint({
        type: "constant",
        color: paint.type === "constant" ? paint.color : constantFallback,
      });
      return;
    }
    const field = fields.find((f) => f.name === value);
    if (!field) return;
    // A numeric switch keeps the scale mode; categorical fields have none.
    apply({
      attribute: value,
      method: field.numeric
        ? continuous
          ? "continuous"
          : "quantile"
        : "categorical",
    });
  };

  const changeMethod = (next: ClassifyMethod) => {
    if (!attribute) return;
    if (next === "categorical") {
      apply({ attribute, method: next, reversed });
    } else {
      // Palette kinds differ; keep it only when staying on a numeric ramp.
      apply({
        attribute,
        method: next,
        palette: paint.type === "quantile" ? (palette ?? undefined) : undefined,
        classes: classes ?? 5,
        reversed,
      });
    }
  };

  const changeRamp = (overrides: {
    palette?: string;
    classes?: number;
    reversed?: boolean;
  }) => {
    if (!attribute) return;
    if (paint.type === "continuous") {
      applyContinuous({
        attribute,
        method: "continuous",
        palette: overrides.palette ?? (palette ?? undefined),
        reversed: overrides.reversed ?? reversed,
      });
      return;
    }
    // A custom scale keeps its breaks through palette-level changes:
    // recolor in place from the catalog, no reclassification round trip.
    // Only a class-count change recomputes — from the base method, which
    // also exits Custom.
    if (
      paint.type === "quantile" &&
      paint.method === "custom" &&
      overrides.classes === undefined
    ) {
      const nextReversed = overrides.reversed ?? reversed;
      const nextName = overrides.palette ?? paint.palette;
      if (nextName !== "custom") {
        onPaint({
          ...paint,
          palette: nextName,
          colors: sequentialColors(paint.colors.length, nextName, nextReversed),
          ...(nextReversed ? { reversed: true } : { reversed: undefined }),
        });
      } else if (
        overrides.reversed !== undefined &&
        overrides.reversed !== reversed
      ) {
        // Hand-edited colors have no catalog entry: reversing flips them.
        onPaint({
          ...paint,
          colors: [...paint.colors].reverse(),
          ...(nextReversed ? { reversed: true } : { reversed: undefined }),
        });
      }
      return;
    }
    apply({
      attribute,
      method: namedMethod,
      palette:
        overrides.palette ??
        (palette === "custom" ? undefined : (palette ?? undefined)),
      classes:
        method === "categorical" ? undefined : (overrides.classes ?? classes),
      reversed: overrides.reversed ?? reversed,
    });
  };

  // Manual overrides: individual class colors and boundaries are edited in
  // place; any palette-level action above recomputes and replaces them
  // (decision 3). "custom" marks the palette as hand-edited.
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
    <>
      <SelectRow
        label="Color by"
        name={`${channel} color attribute`}
        value={dataDriven ? (attribute ?? "constant") : "constant"}
        disabled={disabled}
        onChange={changeAttribute}
      >
        <option value="constant">Single color</option>
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </SelectRow>

      {!dataDriven && (
        <ColorRow
          label="Color"
          name={`${channel} color`}
          color={paint.type === "constant" ? paint.color : constantFallback}
          onChange={(color) => onPaint({ type: "constant", color })}
        />
      )}

      {dataDriven && (
        <>
          {attributeField?.numeric && (
            <div className={styles.row}>
              <span className={styles.rowLabel}>Scale</span>
              <div className={styles.segments} data-two>
                <button
                  type="button"
                  className={styles.segment}
                  data-active={!continuous}
                  disabled={disabled}
                  onClick={() => changeScale("classified")}
                >
                  Classified
                </button>
                <button
                  type="button"
                  className={styles.segment}
                  data-active={continuous}
                  disabled={disabled}
                  onClick={() => changeScale("continuous")}
                >
                  Continuous
                </button>
              </div>
            </div>
          )}

          {attributeField?.numeric && !continuous && (
            <SelectRow
              label="Method"
              name={`${channel} classification method`}
              value={method}
              disabled={disabled}
              onChange={(value) => changeMethod(value as ClassifyMethod)}
            >
              {method === "custom" && (
                <option value="custom" disabled>
                  Custom
                </option>
              )}
              <option value="quantile">Quantile</option>
              <option value="equal">Equal interval</option>
              <option value="natural">Natural breaks</option>
              <option value="categorical">Categories</option>
            </SelectRow>
          )}

          <PaletteControl
            kind={paletteKind}
            name={`Choose ${channel.toLowerCase()} palette`}
            palette={palette}
            currentColors={currentHexes}
            classes={
              method === "categorical" || continuous
                ? undefined
                : (classes ?? 5)
            }
            continuous={continuous}
            reversed={reversed}
            disabled={disabled}
            onChange={changeRamp}
          />

          {paint.type === "quantile" &&
            stats?.kind === "numeric" &&
            stats.min !== null &&
            stats.max !== null &&
            stats.bins.length > 0 && (
              <BreakBrush
                paint={paint}
                min={stats.min}
                max={stats.max}
                mean={stats.mean}
                bins={stats.bins}
                integer={(attributeField?.type ?? "")
                  .toUpperCase()
                  .includes("INT")}
                disabled={disabled}
                onPaint={onPaint}
                onPaintPreview={onPaintPreview}
                onPaintCommit={onPaintCommit}
              />
            )}

          {paint.type === "continuous" &&
            stats?.kind === "numeric" &&
            stats.min !== null &&
            stats.max !== null &&
            stats.bins.length > 0 && (
              <ContinuousBrush
                paint={paint}
                min={stats.min}
                max={stats.max}
                mean={stats.mean}
                bins={stats.bins}
                disabled={disabled}
                onPaint={onPaint}
                onPaintPreview={onPaintPreview}
                onPaintCommit={onPaintCommit}
              />
            )}

          {legend && legend.kind !== "continuous" && (
            <div className={styles.legendPreview}>
              {legend.entries.map((e, i) => (
                <div key={i} className={styles.legendRow}>
                  <input
                    type="color"
                    className={styles.legendSwatchInput}
                    title="Edit this class color"
                    aria-label={`${channel} class ${i + 1} color`}
                    value={toHex(e.color)}
                    disabled={disabled}
                    onChange={(ev) =>
                      editColor(i, fromHex(ev.target.value, e.color.a))
                    }
                  />
                  {paint.type === "quantile" && i < paint.breaks.length ? (
                    <span className={styles.legendLabel}>
                      {i === 0 ? "<" : `${compactNumber(paint.breaks[i - 1])} –`}{" "}
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
              ))}
              <p className={styles.editHint}>
                {method === "custom"
                  ? "Custom boundaries: palettes just recolor; picking a " +
                    "method or changing steps recomputes."
                  : "Click a color or boundary to edit it."}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

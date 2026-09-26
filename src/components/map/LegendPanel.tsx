"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LayerStyle, RgbaColor } from "@/lib/style/style";
import {
  constantSwatch,
  legendFor,
  type Legend,
  type LegendRamp,
  type SizeChannel,
} from "@/lib/style/legend";
import { sequentialColors, DEFAULT_SEQUENTIAL } from "@/lib/style/palettes";
import type { LayerViz, LegendAttrs } from "@/lib/viz";
import type { LayerRenderGeometryType } from "@/lib/layer-service";
import { GradientRamp } from "../GradientRamp";
import { fitLegendWidth } from "./legend-fit";
import styles from "./LegendPanel.module.css";

/** The horizontal rows the width rule measures, and the fluid pieces
 * that contribute a floor instead of a wish (legend-fit). */
const FIT_CLASSES = {
  rows: [
    styles.title,
    styles.constantRow,
    styles.entry,
    styles.heatRow,
    styles.sizeRow,
    styles.rampAxis,
    styles.channelHead,
  ],
  fluid: [styles.heatRamp, styles.rampBar],
};

function rgba(c: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

/** The panel's own contribution rule, callable without rendering: which
 * layers actually put an entry in the legend. The export card asks this
 * to decide legend presence — one predicate, no drift. */
export function legendItems(layers: NamedStyle[]) {
  return layers
    .filter((l) => l.visible && l.inLegend !== false)
    .map((l) => {
      const heatmap = l.viz?.type === "heatmap";
      const legend = heatmap ? null : legendFor(l.style, l.viz);
      return {
        id: l.id,
        title: l.legendTitle?.trim() || l.name,
        layerName: l.name,
        heatmap,
        legend,
        // An all-constant layer shows one swatch row: the colour it
        // actually draws, stroke for stroked geometries.
        constant:
          heatmap || legend !== null
            ? null
            : constantSwatch(l.style, l.viz, l.geometryType),
        labels: l.legendLabels ?? null,
        attrs: l.legendAttrs ?? null,
      };
    })
    .filter((l) => l.heatmap || l.legend !== null || l.constant !== null);
}

export interface NamedStyle {
  /** Layer id — lets builder clicks name their layer. */
  id?: string;
  name: string;
  style: LayerStyle;
  visible: boolean;
  /** Layers can be excluded from the legend; default included. */
  inLegend?: boolean;
  /** Heatmaps show a density ramp instead of fill classes. */
  viz?: LayerViz;
  /** The rendered geometry, when known: the constant-row
   * swatch shows the stroke for stroked geometries, the fill elsewhere. */
  geometryType?: LayerRenderGeometryType;
  /** Legend text overrides; absent/null = automatic. */
  legendTitle?: string | null;
  legendLabels?: (string | null)[] | null;
  /** Per-channel attribute-name overrides; null = automatic. */
  legendAttrs?: LegendAttrs | null;
}

const HEAT_RAMP_CSS = `linear-gradient(90deg, ${sequentialColors(
  6,
  DEFAULT_SEQUENTIAL,
  false,
)
  .map(rgba)
  .join(", ")})`;

/** What a color channel is called when a block shows more than one. */
const CHANNEL_NAME = {
  fill: "fill",
  stroke: "outline",
  radius: "size",
  width: "width",
  height: "height",
} as const;

/** A piece of legend text the builder can click to edit. */
export interface LegendTextTarget {
  layerId: string;
  field: "title" | "attr" | "label";
  /** For attr clicks: which channel's variable name. */
  channel?: keyof LegendAttrs;
  /** For label clicks: the slot index in display order. */
  slot?: number;
}

/**
 * A legend label that edits in place: click puts a caret in the text right
 * there — no rail round-trip. Blank or the automatic text commits as
 * automatic; Enter commits, Escape cancels.
 */
function InlineLabel({
  auto,
  override,
  onCommit,
  context,
}: {
  auto: string;
  override: string | null;
  onCommit: ((value: string | null) => void) | null;
  /** Names the edit affordance for assistive tech — the layer's
   *  name, so labels in different layers tell apart even when legend
   *  titles collide. */
  context?: string;
}) {
  const display = override?.trim() || auto;
  const [draft, setDraft] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // A keyboard exit (Enter/Escape) puts focus back on the button the
  // editor replaced; a pointer blur means focus went somewhere on
  // purpose and must not be yanked back.
  const restoreFocus = useRef(false);
  const enterArmed = useRef(false);
  useEffect(() => {
    if (draft === null && restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [draft]);

  if (!onCommit) return <>{display}</>;
  if (draft === null) {
    return (
      <button
        ref={buttonRef}
        type="button"
        className={styles.editable}
        data-hint="Click to edit"
        data-hint-always=""
        aria-label={`Edit label "${display}"${context ? `, ${context}` : ""}`}
        onClick={() => setDraft(display)}
      >
        {display}
      </button>
    );
  }
  return (
    <input
      className={styles.labelInput}
      value={draft}
      autoFocus
      aria-label={`Legend label${context ? `, ${context}` : ""}`}
      size={Math.max(draft.length, 4)}
      onFocus={(e) =>
        e.currentTarget.setSelectionRange(
          e.currentTarget.value.length,
          e.currentTarget.value.length,
        )
      }
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const value = draft.trim();
        setDraft(null);
        onCommit(value === "" || value === auto ? null : value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          enterArmed.current = true;
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          restoreFocus.current = true;
          setDraft(null); // cancel — nothing commits
        }
      }}
      onKeyUp={(e) => {
        // Commit on a release whose press STARTED here: a keydown-blur
        // let the same press's keyup re-activate the restored button
        // (reopening the editor), and a bare keyup-commit let the
        // opening press's release close it — the armed pair takes both
        // halves from the same key travel.
        if (e.key === "Enter" && enterArmed.current) {
          enterArmed.current = false;
          restoreFocus.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function sizeRowText(s: SizeChannel): string {
  return `${s.labels[0]} – ${s.labels[1]}`;
}

/** The continuous ramp as a CSS gradient — stop positions
 * honored so custom palettes read exactly as they map. */
function rampCss(ramp: LegendRamp): string {
  const n = ramp.colors.length;
  const at = (i: number) =>
    ramp.positions ? ramp.positions[i] : n === 1 ? 0 : i / (n - 1);
  return `linear-gradient(90deg, ${ramp.colors
    .map((c, i) => `${rgba(c)} ${(at(i) * 100).toFixed(1)}%`)
    .join(", ")})`;
}

/**
 * Map legend, derived from layer styles: every data-driven channel shows —
 * fill and outline classes, size ranges; constant channels show none.
 * Shared by builder and published viewer; the builder passes onTextClick so
 * legend text becomes an edit shortcut.
 */
export function LegendPanel({
  layers,
  onTextClick,
  onLabelEdit,
  docked = false,
}: {
  layers: NamedStyle[];
  onTextClick?: (target: LegendTextTarget) => void;
  /** Builder only: labels edit in place. */
  onLabelEdit?: (layerId: string, slot: number, value: string | null) => void;
  /** A rail child fills the widget-card column instead of applying the
   * standalone variant-D content fit. */
  docked?: boolean;
}) {
  const items = legendItems(layers);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // The width rule (legend-fit): refit whenever content changes, and
  // once more when the fonts settle — measured text is font-shaped.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (docked) {
      card.style.removeProperty("width");
      return;
    }
    fitLegendWidth(card, FIT_CLASSES);
    let stale = false;
    void document.fonts?.ready?.then(() => {
      if (!stale && cardRef.current) fitLegendWidth(cardRef.current, FIT_CLASSES);
    });
    return () => {
      stale = true;
    };
  }, [layers, docked]);

  if (items.length === 0) return null;

  return (
    <div
      className={styles.legend}
      data-map-legend
      data-docked={docked || undefined}
      ref={cardRef}
    >
      {items.map(
        (
          { id, title, layerName, heatmap, legend, constant, labels, attrs },
          block,
        ) => (
        <div key={`${title}:${block}`} className={styles.block}>
          <LegendBlock
            title={title}
            layerName={layerName}
            heatmap={heatmap}
            legend={legend}
            constant={constant}
            labels={labels}
            attrs={attrs}
            onText={
              onTextClick && id
                ? (t) => onTextClick({ layerId: id, ...t })
                : undefined
            }
            onLabel={
              onLabelEdit && id
                ? (slot, value) => onLabelEdit(id, slot, value)
                : undefined
            }
          />
        </div>
        ),
      )}
    </div>
  );
}

function LegendBlock({
  title,
  layerName,
  heatmap,
  legend,
  constant,
  labels,
  attrs,
  onText,
  onLabel,
}: {
  title: string;
  /** The layer's own name — naming context that survives legend-title
   *  collisions. */
  layerName: string;
  heatmap: boolean;
  legend: Legend | null;
  /** The all-constant swatch; null when channels exist. */
  constant: RgbaColor | null;
  labels: (string | null)[] | null;
  attrs: LegendAttrs | null;
  onText?: (target: Omit<LegendTextTarget, "layerId">) => void;
  onLabel?: (slot: number, value: string | null) => void;
}) {
  const clickable = onText !== undefined;
  /** Builder-only: the text is a real edit control — focusable,
   *  named, and keyboard-activatable — that hands off to its rail field
   *  exactly as the click always has. Viewers get plain text. */
  const editText = (
    target: Omit<LegendTextTarget, "layerId">,
    name: string,
    content: ReactNode,
  ) =>
    clickable ? (
      <button
        type="button"
        className={styles.editable}
        data-hint="Click to edit"
        data-hint-always=""
        aria-label={name}
        onClick={() => onText(target)}
      >
        {content}
      </button>
    ) : (
      <span>{content}</span>
    );

  // The all-constant row: the layer's one colour beside its title — no
  // attribute line, no label slots.
  if (constant) {
    return (
      <div className={styles.constantRow}>
        <span
          className={styles.swatch}
          style={{ background: rgba(constant) }}
        />
        <span className={styles.constantTitle}>
          {editText(
            { field: "title" },
            `Edit legend title, ${layerName}`,
            title,
          )}
        </span>
      </div>
    );
  }

  if (heatmap || !legend) {
    return (
      <>
        <div className={styles.title}>
          {editText(
            { field: "title" },
            `Edit legend title, ${layerName}`,
            title,
          )}
        </div>
        <div className={styles.heatRow}>
          <GradientRamp className={styles.heatRamp} gradient={HEAT_RAMP_CSS} />
          <span className={styles.label}>
            <InlineLabel
              auto="density"
              override={labels?.[0] ?? null}
              onCommit={onLabel ? (v) => onLabel(0, v) : null}
              context={layerName}
            />
          </span>
        </div>
      </>
    );
  }

  // One color channel and nothing else keeps the compact layout; more
  // channels get labelled sub-blocks. Label overrides are positional across
  // all slots in display order (paint entries, then size rows); attribute
  // names are overridable per channel and hideable — an explicit null
  // renders no attribute line at all.
  const attrName = (channel: keyof LegendAttrs, auto: string): string | null => {
    const v = attrs?.[channel];
    if (v === null) return null;
    return v?.trim() || auto;
  };
  const attrSpan = (channel: keyof LegendAttrs, auto: string) => {
    const name = attrName(channel, auto);
    return name === null ? null : (
      <span className={styles.attr}>
        {editText(
          { field: "attr", channel },
          `Edit ${CHANNEL_NAME[channel] ?? channel} variable name, ${layerName}`,
          name,
        )}
      </span>
    );
  };
  const multi = legend.paints.length + legend.sizes.length > 1;
  const paintBase: number[] = [];
  let slots = 0;
  for (const p of legend.paints) {
    paintBase.push(slots);
    slots += p.entries.length;
  }
  const sizeBase = legend.sizes.map((_, i) => slots + i);
  return (
    <>
      <div className={styles.title}>
        {editText({ field: "title" }, `Edit legend title, ${layerName}`, title)}
        {!multi &&
          legend.paints[0] &&
          attrSpan(legend.paints[0].channel, legend.paints[0].attribute)}
        {!multi &&
          legend.sizes[0] &&
          !legend.paints[0] &&
          attrSpan(legend.sizes[0].channel, legend.sizes[0].attribute)}
      </div>
      {legend.paints.map((p, pi) => {
        const base = paintBase[pi];
        return (
          <div key={p.channel} className={styles.channel}>
            {multi && (
              <div className={styles.channelHead}>
                {CHANNEL_NAME[p.channel]}
                {attrSpan(p.channel, p.attribute)}
              </div>
            )}
            {p.kind === "continuous" && p.ramp ? (
              <div className={styles.rampRow}>
                <GradientRamp
                  className={styles.rampBar}
                  data-ramp
                  gradient={rampCss(p.ramp)}
                />
                <div className={styles.rampAxis}>
                  <span>{p.ramp.labels[0]}</span>
                  {p.ramp.center !== undefined && (
                    <span className={styles.rampCenter}>
                      ◦ {p.ramp.center}
                    </span>
                  )}
                  <span>{p.ramp.labels[1]}</span>
                </div>
              </div>
            ) : (
              <ul className={styles.entries}>
                {p.entries.map((e, i) => (
                  <li key={i} className={styles.entry}>
                    <span
                      className={styles.swatch}
                      style={{ background: rgba(e.color) }}
                    />
                    <span className={styles.label}>
                      <InlineLabel
                        auto={e.label}
                        override={labels?.[base + i] ?? null}
                        onCommit={onLabel ? (v) => onLabel(base + i, v) : null}
                        context={layerName}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {legend.sizes.map((s, si) => {
        const mySlot = sizeBase[si];
        return (
          <div key={s.channel} className={styles.channel}>
            {multi && (
              <div className={styles.channelHead}>
                {CHANNEL_NAME[s.channel]}
                {attrSpan(s.channel, s.attribute)}
              </div>
            )}
            <div className={styles.sizeRow}>
              <span className={styles.sizeGlyph} aria-hidden>
                {s.channel === "height" ? (
                  <>
                    <i className={styles.barSmall} />
                    <i className={styles.barLarge} />
                  </>
                ) : (
                  <>
                    <i className={styles.dotSmall} />
                    <i className={styles.dotLarge} />
                  </>
                )}
              </span>
              <span className={styles.label}>
                <InlineLabel
                  auto={sizeRowText(s)}
                  override={labels?.[mySlot] ?? null}
                  onCommit={onLabel ? (v) => onLabel(mySlot, v) : null}
                  context={layerName}
                />
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

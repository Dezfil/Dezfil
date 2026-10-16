"use client";

import { useEffect, useRef, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { Corner } from "@/lib/corners";
import { legendFor, type Legend } from "@/lib/style/legend";
import type { RgbaColor } from "@/lib/style/style";
import { effectiveStyle, type LegendAttrs, type LegendChannelKey } from "@/lib/viz";
import { rgbaCss } from "@/lib/style/color";
import { EyeIcon, EyeOffIcon, GripIcon } from "../ui/icons";
import { Checkbox } from "../ui/Field";
import { CornerPicker } from "../ui/CornerPicker";
import { SortableCards } from "../widgets/SortableCards";
import { orderForLegend } from "@/lib/style/legend-order";
import { UnsavedLayer } from "./UnsavedFields";
import panel from "./panel.module.css";
import styles from "./LegendTab.module.css";

/** In-progress legend text: mirrored to the canvas legend on
 * every keystroke; persistence still happens on blur. A field sent as
 * `undefined` leaves the live text: the legend draws its stored text. */
export interface LegendLiveText {
  legendTitle?: string | null;
  legendLabels?: (string | null)[] | null;
  legendAttrs?: LegendAttrs | null;
}

/** A one-shot request to land the caret in a legend field. */
export interface LegendFocus {
  layerId: string;
  field: "title" | "attr" | "label";
  channel?: LegendChannelKey;
  slot?: number;
  nonce: number;
}

interface Props {
  layers: Layer[];
  /** Where the legend sits; null = bottom-left. */
  corner: Corner | null;
  /** The manual arrangement; null = follow the panel. */
  legendOrder: string[] | null;
  onCorner: (corner: Corner) => void;
  /** Set when canvas legend text was clicked — focus that field. */
  focus?: LegendFocus | null;
  onToggle: (id: string, inLegend: boolean) => void;
  onTitle: (id: string, title: string | null) => void;
  onLabels: (id: string, labels: (string | null)[] | null) => void;
  onAttrs: (id: string, attrs: LegendAttrs | null) => void;
  /** Every keystroke — the canvas legend mirrors it live. */
  onLive: (id: string, text: LegendLiveText) => void;
  /** The whole arrangement after a move, top first. */
  onReorder: (topFirstIds: string[]) => void;
  onResetOrder: () => void;
}

/** One editable legend line: a class swatch, or a size row (color = null). */
interface Slot {
  color: RgbaColor | null;
  placeholder: string;
}

/** One data-driven channel: its key and the automatic attribute name the
 * legend would show (the name is editable per channel). */
interface Channel {
  key: LegendChannelKey;
  attribute: string;
}

/** Flatten a legend into its label slots, in display order:
 * paint entries first, then one row per size channel. */
function slotsFor(legend: Legend): Slot[] {
  const slots: Slot[] = [];
  for (const p of legend.paints) {
    for (const e of p.entries) slots.push({ color: e.color, placeholder: e.label });
  }
  for (const s of legend.sizes) {
    slots.push({ color: null, placeholder: `${s.labels[0]} – ${s.labels[1]}` });
  }
  return slots;
}

function channelsFor(legend: Legend): Channel[] {
  return [
    ...legend.paints.map((p) => ({ key: p.channel, attribute: p.attribute })),
    ...legend.sizes.map((s) => ({ key: s.channel, attribute: s.attribute })),
  ];
}

/**
 * Legend tab: place the legend in a corner, include or exclude each layer,
 * and edit its legend title, per-channel variable names (hideable), and
 * per-slot labels (slots span every data-driven channel) — blank restores
 * the automatic text. Constant styles contribute one swatch row; their
 * title edits like any other layer's.
 */
export function LegendTab({
  layers,
  corner,
  legendOrder,
  onCorner,
  focus,
  onToggle,
  onTitle,
  onLabels,
  onAttrs,
  onLive,
  onReorder,
  onResetOrder,
}: Props) {
  const activeCorner = corner ?? "bottom-left";
  const cornerPicker = (
    <div className={styles.cornerRow}>
      <span className={panel.sectionLabel}>Corner</span>
      <CornerPicker
        label="Legend corner"
        value={activeCorner}
        onChange={onCorner}
      />
    </div>
  );

  if (layers.length === 0) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>No layers yet.</p>
        {cornerPicker}
      </div>
    );
  }

  // The legend's own order: the panel's way, or the stored arrangement
  // — the exact sequence the on-map card renders.
  const ordered = orderForLegend(layers, legendOrder);
  const byId = new Map(ordered.map((l) => [l.id, l]));

  const row = (id: string, floating: boolean, dragging?: boolean, handle?: Parameters<Parameters<typeof SortableCards>[0]["render"]>[3]) => {
    const layer = byId.get(id);
    if (!layer) return null;
    const heatmap = layer.viz.type === "heatmap";
    const legend = heatmap
      ? null
      : legendFor(effectiveStyle(layer.style, layer.viz), layer.viz);
    const slots = legend ? slotsFor(legend) : [];
    const channels = legend ? channelsFor(legend) : [];
    return (
      <div className={styles.item} data-legend-row={layer.id}>
        <div className={styles.row}>
          <button
            type="button"
            ref={handle?.ref}
            {...handle?.attributes}
            className={`${styles.grip} ${panel.hint}`}
            data-hint="Drag or Space to reorder"
            aria-label={`Reorder ${layer.name} in the legend`}
          >
            <GripIcon />
          </button>
          {/* The checkbox is a control, not a grab surface (PR round):
              display:contents keeps the row's layout while the mark
              opts its subtree out of drag activation. */}
          <span style={{ display: "contents" }} data-no-dnd>
            <Checkbox
              className={styles.check}
              checked={layer.inLegend}
              onChange={(e) => onToggle(layer.id, e.target.checked)}
              label={<span className={styles.name}>{layer.name}</span>}
            />
          </span>
        </div>

        {layer.inLegend && !floating && !dragging && (
          <div data-no-dnd>
          <LegendEditor
            // Remount only when the slot/channel structure changes.
            // Persisted-text changes reconcile inside the editor: the
            // echo of its own commit keeps every other in-progress
            // draft and focus; an external change refreshes every field
            // to committed but the one being typed in.
            key={`${layer.id}:${slots.length}:${channels.map((c) => c.key).join()}`}
            layer={layer}
            slots={slots}
            channels={channels}
            focus={focus?.layerId === layer.id ? focus : null}
            onTitle={onTitle}
            onLabels={onLabels}
            onAttrs={onAttrs}
            onLive={onLive}
          />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.panel}>
      {legendOrder !== null && (
        // Contextual reveal (the working habit): the reset exists only
        // while there is a manual order to reset.
        <div className={styles.orderRow}>
          <span className={styles.orderNote}>Custom order</span>
          <button
            type="button"
            className={styles.orderReset}
            onClick={onResetOrder}
          >
            Reset order
          </button>
        </div>
      )}
      <div className={styles.list} data-legend-rows>
        <SortableCards
          ids={ordered.map((l) => l.id)}
          onReorder={onReorder}
          render={row}
          overlayWidth="100%"
          keyboardNames={new Map(ordered.map((l) => [l.id, l.name]))}
        />
      </div>
      {cornerPicker}
    </div>
  );
}

function LegendEditor({
  layer,
  slots,
  channels,
  focus,
  onTitle,
  onLabels,
  onAttrs,
  onLive,
}: {
  layer: Layer;
  slots: Slot[];
  channels: Channel[];
  focus: LegendFocus | null;
  onTitle: (id: string, title: string | null) => void;
  onLabels: (id: string, labels: (string | null)[] | null) => void;
  onAttrs: (id: string, attrs: LegendAttrs | null) => void;
  onLive: (id: string, text: LegendLiveText) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const attrRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const labelRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!focus) return;
    const target =
      focus.field === "title"
        ? titleRef.current
        : focus.field === "attr"
          ? attrRefs.current[focus.channel ?? ""]
          : labelRefs.current[focus.slot ?? -1];
    target?.focus();
  }, [focus]);
  const [title, setTitle] = useState(layer.legendTitle ?? "");
  const [labels, setLabels] = useState<string[]>(
    slots.map((_, i) => layer.legendLabels?.[i] ?? ""),
  );
  // Per channel: text = custom, "" = automatic, null = hidden.
  const [attrs, setAttrs] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      channels.map((c) => {
        const v = layer.legendAttrs?.[c.key];
        return [c.key, v === null ? null : (v ?? "")];
      }),
    ),
  );

  // Committed-text reconciliation ---- Commits this editor sent and has
  // not yet seen echoed. An arriving committed change that matches one
  // is the editor's own echo: only the echoed piece refreshes. A change
  // matching none is external (undo/redo, the assistant, API, another
  // surface, a refused save's rollback): every field refreshes to
  // committed. Neither overwrites text the author has typed into the
  // field with the caret: it stays, and leaving the field saves it.
  const sentTitle = useRef<(string | null)[]>([]);
  const sentLabels = useRef<string[]>([]);
  const sentAttrs = useRef<string[]>([]);
  // Attr objects can echo with a different key order; compare canonically.
  const canonAttrs = (a: LegendAttrs | null | undefined): string =>
    JSON.stringify(
      a == null
        ? null
        : Object.keys(a)
            .sort()
            .map((k) => [k, (a as Record<string, string | null>)[k]]),
    );

  /** The canvas-facing labels value for an in-progress edit. */
  const labelsValue = (state: string[]): (string | null)[] | null => {
    const next = state.map((s) => s.trim() || null);
    return next.every((v) => v === null) ? null : next;
  };

  const attrsValue = (
    state: Record<string, string | null>,
  ): LegendAttrs | null => {
    const entries = channels
      .map((c) => {
        const v = state[c.key];
        if (v === null) return [c.key, null] as const; // hidden
        const t = (v ?? "").trim();
        return t === "" ? null : ([c.key, t] as const);
      })
      .filter((e): e is [LegendChannelKey, string | null] => e !== null);
    return entries.length ? Object.fromEntries(entries) : null;
  };
  const committedJson = JSON.stringify([
    layer.legendTitle ?? null,
    layer.legendLabels ?? null,
    canonAttrs(layer.legendAttrs),
  ]);
  const seenJson = useRef(committedJson);
  useEffect(() => {
    if (committedJson === seenJson.current) return;
    const [prevTitle, prevLabels, prevAttrs] = JSON.parse(
      seenJson.current,
    ) as [string | null, (string | null)[] | null, string];
    seenJson.current = committedJson;
    const focused = document.activeElement;

    const titleNow = layer.legendTitle ?? null;
    const titleChanged = titleNow !== prevTitle;
    const labelsNow = layer.legendLabels ?? null;
    const labelsChanged =
      JSON.stringify(labelsNow) !== JSON.stringify(prevLabels);
    const attrsNow = canonAttrs(layer.legendAttrs);
    const attrsChanged = attrsNow !== prevAttrs;

    let external = false;
    if (titleChanged) {
      const at = sentTitle.current.indexOf(titleNow);
      if (at === -1) external = true;
      else sentTitle.current = sentTitle.current.slice(at + 1);
    }
    if (labelsChanged) {
      const at = sentLabels.current.indexOf(JSON.stringify(labelsNow));
      if (at === -1) external = true;
      else sentLabels.current = sentLabels.current.slice(at + 1);
    }
    if (attrsChanged) {
      const at = sentAttrs.current.indexOf(attrsNow);
      if (at === -1) external = true;
      else sentAttrs.current = sentAttrs.current.slice(at + 1);
    }
    if (external) {
      sentTitle.current = [];
      sentLabels.current = [];
      sentAttrs.current = [];
    }

    // The field with the caret keeps its draft only where the author has
    // typed something other than the stored text it showed before this
    // change. A draft still reading as that text takes the new stored
    // text like any other field; keeping it would put the older text
    // back on leaving.
    const typedTitle =
      focused === titleRef.current && (title.trim() || null) !== prevTitle;
    const focusedSlot = slots.findIndex(
      (_, i) => labelRefs.current[i] != null && labelRefs.current[i] === focused,
    );
    const typedSlot =
      focusedSlot !== -1 &&
      ((labels[focusedSlot] ?? "").trim() || null) !==
        (prevLabels?.[focusedSlot] ?? null)
        ? focusedSlot
        : -1;
    const focusedChannel = channels.find(
      (c) => attrRefs.current[c.key] != null && attrRefs.current[c.key] === focused,
    );
    const attrsBefore = Object.fromEntries(
      (JSON.parse(prevAttrs) as [string, string | null][] | null) ?? [],
    ) as Record<string, string | null | undefined>;
    const draftAttr = (v: string | null | undefined) =>
      v === null ? null : (v ?? "").trim() || undefined;
    const typedChannel =
      focusedChannel &&
      draftAttr(attrs[focusedChannel.key]) !== attrsBefore[focusedChannel.key]
        ? focusedChannel.key
        : null;
    const committedAttr = (key: LegendChannelKey) => {
      const v = layer.legendAttrs?.[key];
      return v === null ? null : (v ?? "");
    };

    // Own echo: only the echoed piece converges to its stored text; an
    // external change: every piece. Never a draft typed in the field with
    // the caret, whatever moved the committed text: that draft is theirs.
    if ((titleChanged || external) && !typedTitle) {
      setTitle(layer.legendTitle ?? "");
    }
    if (labelsChanged || external) {
      setLabels((cur) =>
        slots.map((_, i) =>
          i === typedSlot ? (cur[i] ?? "") : (layer.legendLabels?.[i] ?? ""),
        ),
      );
    }
    if (attrsChanged || external) {
      setAttrs((cur) =>
        Object.fromEntries(
          channels.map((c) => [
            c.key,
            c.key === typedChannel ? (cur[c.key] ?? "") : committedAttr(c.key),
          ]),
        ),
      );
    }
    // The builder discards this layer's whole live-text entry when the
    // echo lands (a recovered read is authoritative), which also drops
    // the canvas mirror of the draft the author is still typing —
    // republish a kept draft so the canvas legend keeps showing exactly
    // what the editor shows, after an external change too. A field that
    // took the stored text leaves the live text, so keystrokes typed and
    // erased back to the older stored text are not drawn over the new.
    const live: LegendLiveText = {};
    if (typedTitle) live.legendTitle = title.trim() || null;
    else if (titleChanged || external) live.legendTitle = undefined;
    if (typedSlot !== -1) {
      live.legendLabels = labelsValue(
        slots.map((_, i) =>
          i === typedSlot ? (labels[i] ?? "") : (layer.legendLabels?.[i] ?? ""),
        ),
      );
    } else if (labelsChanged || external) live.legendLabels = undefined;
    if (typedChannel) {
      live.legendAttrs = attrsValue(
        Object.fromEntries(
          channels.map((c) => [
            c.key,
            c.key === typedChannel ? (attrs[c.key] ?? "") : committedAttr(c.key),
          ]),
        ),
      );
    } else if (attrsChanged || external) live.legendAttrs = undefined;
    if (Object.keys(live).length) onLive(layer.id, live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedJson]);

  const commitTitle = () => {
    const next = title.trim() || null;
    if (next !== (layer.legendTitle ?? null)) {
      sentTitle.current.push(next);
      onTitle(layer.id, next);
    }
  };

  const commitLabels = () => {
    const next = labels.map((s) => s.trim() || null);
    const value = next.every((v) => v === null) ? null : next;
    if (JSON.stringify(value) !== JSON.stringify(layer.legendLabels)) {
      sentLabels.current.push(JSON.stringify(value ?? null));
      onLabels(layer.id, value);
    }
  };

  const commitAttrs = (state: Record<string, string | null> = attrs) => {
    const value = attrsValue(state);
    if (JSON.stringify(value) !== JSON.stringify(layer.legendAttrs)) {
      sentAttrs.current.push(canonAttrs(value));
      onAttrs(layer.id, value);
    }
  };

  const toggleAttrHidden = (key: LegendChannelKey) => {
    // Hiding discards any custom text; showing returns to automatic.
    const next = { ...attrs, [key]: attrs[key] === null ? "" : null };
    setAttrs(next);
    onLive(layer.id, { legendAttrs: attrsValue(next) });
    commitAttrs(next);
  };

  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const hasOverrides =
    layer.legendTitle !== null ||
    layer.legendLabels !== null ||
    layer.legendAttrs !== null;

  return (
    <div className={styles.editor}>
      <UnsavedLayer layer={layer} field="legendTitle" />
      <input
        ref={titleRef}
        className={styles.titleInput}
        value={title}
        placeholder={layer.name}
        title="Legend title"
        aria-label={`Legend title, ${layer.name}`}
        onChange={(e) => {
          setTitle(e.target.value);
          onLive(layer.id, { legendTitle: e.target.value.trim() || null });
        }}
        onBlur={commitTitle}
        onKeyDown={blurOnEnter}
      />
      {channels.map((c) => {
        const hidden = attrs[c.key] === null;
        return (
          <div key={c.key} className={styles.attrRow}>
            <span className={styles.attrLabel}>
              {channels.length > 1 ? `${c.key} variable` : "variable"}
            </span>
            <input
              ref={(node) => {
                attrRefs.current[c.key] = node;
              }}
              className={styles.attrInput}
              value={hidden ? "" : (attrs[c.key] ?? "")}
              placeholder={hidden ? "hidden" : c.attribute}
              disabled={hidden}
              aria-label={`${c.key} variable name, ${layer.name}`}
              onChange={(e) => {
                const next = { ...attrs, [c.key]: e.target.value };
                setAttrs(next);
                onLive(layer.id, { legendAttrs: attrsValue(next) });
              }}
              onBlur={() => commitAttrs()}
              onKeyDown={blurOnEnter}
            />
            <button
              type="button"
              className={`${styles.attrHide} ${panel.hint}`}
              data-hint={hidden ? "Show variable name" : "Hide variable name"}
              data-off={hidden}
              aria-pressed={!hidden}
              aria-label={`${hidden ? "Show" : "Hide"} ${c.key} variable name, ${layer.name}`}
              onClick={() => toggleAttrHidden(c.key)}
            >
              {hidden ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        );
      })}
      {slots.map((s, i) => (
        <div key={i} className={styles.entryRow}>
          {s.color ? (
            <span
              className={styles.entrySwatch}
              style={{ background: rgbaCss(s.color) }}
            />
          ) : (
            <span className={styles.entryGlyph} aria-hidden>
              <i className={styles.dotSmall} />
              <i className={styles.dotLarge} />
            </span>
          )}
          <input
            ref={(node) => {
              labelRefs.current[i] = node;
            }}
            className={styles.entryInput}
            value={labels[i] ?? ""}
            placeholder={s.placeholder}
            aria-label={`Legend label ${i + 1}, ${layer.name}`}
            onChange={(ev) => {
              const next = labels.map((v, j) => (j === i ? ev.target.value : v));
              setLabels(next);
              onLive(layer.id, { legendLabels: labelsValue(next) });
            }}
            onBlur={commitLabels}
            onKeyDown={blurOnEnter}
          />
        </div>
      ))}
      {hasOverrides && (
        <button
          className={styles.reset}
          onClick={() => {
            onLive(layer.id, {
              legendTitle: null,
              legendLabels: null,
              legendAttrs: null,
            });
            onTitle(layer.id, null);
            onLabels(layer.id, null);
            onAttrs(layer.id, null);
          }}
        >
          Reset to automatic
        </button>
      )}
    </div>
  );
}

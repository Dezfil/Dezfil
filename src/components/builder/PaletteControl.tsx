"use client";

import { useCallback, useId, useRef, useState } from "react";
import {
  PALETTES,
  paletteSwatch,
  rampColors,
  rampStopColor,
  type Palette,
} from "@/lib/style/palettes";
import { toHex } from "@/lib/style/color";
import type {
  CustomPalette,
  CustomPaletteStop,
} from "@/lib/metadata/palettes";
import { GradientRamp } from "../GradientRamp";
import { ErrorNote } from "../ui/ErrorNote";
import { IconButton } from "../ui/IconButton";
import { popoverTriggerProps, usePopoverDismiss } from "../ui/Popover";
import { NumberInput, Select, TextInput } from "../ui/Field";
import { ChevronIcon, PlusIcon, XIcon } from "../ui/icons";
import { SwitchRow } from "../ui/Switch";
import styles from "./PaletteControl.module.css";

/**
 * The collapsed palette control: closed, one row — the active palette's name
 * and its ramp discretized at the current class count (a hand-edited paint
 * shows its actual colors as Custom); open, an inline browser with the type
 * filter, Steps, Reversed, the colorblind-safe filter, and the grouped ramp
 * list. Picking applies and closes; Escape or a click outside dismisses with
 * no change.
 *
 * Since the numeric browser also carries the saved custom palettes —
 * instance-global, fetched on open — and a stop editor to build new ones. In
 * continuous mode the strips render as smooth gradients and the Steps row
 * disappears (an unclassed ramp has no classes).
 */

const RAMP_FILTERS = [
  { key: "all", label: "All" },
  { key: "sequential", label: "Sequential" },
  { key: "diverging", label: "Diverging" },
] as const;

type RampFilter = (typeof RAMP_FILTERS)[number]["key"];

const GROUP_LABELS: Record<Palette["group"], string> = {
  sequential: "Sequential",
  diverging: "Diverging",
  qualitative: "Qualitative",
};

const STEP_CHOICES = [3, 4, 5, 6, 7, 8, 9];

/** Categorical strips show at most the colors a fill can actually use. */
const MAX_STRIP_SWATCHES = 10;

/** A fresh editor draft — a quiet green ramp to start editing from. */
const DRAFT_STOPS: CustomPaletteStop[] = [
  { color: "#f2f0e4", position: 0 },
  { color: "#9cc08b", position: 0.4 },
  { color: "#0d7d5c", position: 0.75 },
  { color: "#0a3d30", position: 1 },
];

/** The ramp as its discrete classes — real segments, not a hard-stop
 * gradient: those bleed a sliver of the last color at the strip's far
 * edge on fractional widths. */
function Strip({
  className,
  colors,
}: {
  className: string;
  colors: string[];
}) {
  return (
    <span className={className} aria-hidden>
      {colors.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** The ramp as a smooth gradient — the continuous read.
 * Rendered through GradientRamp so the ends can't bleed across. */
function GradientStrip({
  className,
  stops,
}: {
  className: string;
  stops: CustomPaletteStop[];
}) {
  const gradient = `linear-gradient(90deg, ${stops
    .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
    .join(", ")})`;
  return <GradientRamp className={className} gradient={gradient} />;
}

/** A curated palette's colors as evenly spaced editor-style stops. */
function evenStops(colors: string[]): CustomPaletteStop[] {
  const n = colors.length;
  return colors.map((color, i) => ({
    color,
    position: n === 1 ? 0 : i / (n - 1),
  }));
}

function reversedStops(stops: CustomPaletteStop[]): CustomPaletteStop[] {
  return [...stops]
    .reverse()
    .map((s) => ({ color: s.color, position: 1 - s.position }));
}

export function PaletteControl({
  kind,
  palette,
  currentColors,
  classes,
  continuous = false,
  reversed,
  disabled,
  name,
  onChange,
}: {
  /** The mechanical axis: numeric ramps or category cycles. */
  kind: Palette["kind"];
  /** The trigger's action name — the visible text is the current
   *  value, which names the state, not the action. */
  name: string;
  /** Current palette name; "custom", retired, or unknown names show as Custom. */
  palette: string | null;
  /** The paint's actual class colors (hex) — the Custom strip. */
  currentColors: string[];
  /** Current class count (numeric ramps only). */
  classes?: number;
  /** Unclassed mode: gradient strips, no Steps row. */
  continuous?: boolean;
  reversed: boolean;
  disabled: boolean;
  /** Same contract as the old Classes/Reverse/grid rows: palette-level
   * actions that reclassify and replace manual edits (semantics). */
  onChange: (overrides: {
    palette?: string;
    classes?: number;
    reversed?: boolean;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<RampFilter>("all");
  const [safeOnly, setSafeOnly] = useState(false);
  const [custom, setCustom] = useState<CustomPalette[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CustomPaletteStop[]>(DRAFT_STOPS);
  const [draftName, setDraftName] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const numeric = kind === "sequential";
  const steps = classes ?? 5;
  const active = PALETTES.find((p) => p.name === palette && p.kind === kind);
  const activeCustom = custom.find((p) => p.name === palette);
  // No flagged palette in scope (qualitative today) → the filter would only
  // strand the user on an empty list; hide it and ignore its state.
  const anySafe = PALETTES.some((p) => p.kind === kind && p.colorblindSafe);

  const refreshCustom = useCallback(async () => {
    try {
      const response = await fetch("/api/palettes");
      if (!response.ok) return;
      const body = (await response.json()) as { custom?: CustomPalette[] };
      setCustom(body.custom ?? []);
    } catch {
      // The picker still works with the bundled catalogue.
    }
  }, []);

  // Dismissal is the kit's popover contract.
  usePopoverDismiss({
    open,
    onClose: useCallback(() => setOpen(false), []),
    contentRef: rootRef,
    triggerRef: headRef,
  });

  const strip = (p: Palette): string[] => {
    const colors = paletteSwatch(p, steps, reversed);
    return p.kind === "categorical" ? colors.slice(0, MAX_STRIP_SWATCHES) : colors;
  };

  const customStrip = (p: CustomPalette): string[] => {
    const ordered = reversed ? reversedStops(p.stops) : p.stops;
    return rampColors(
      ordered.map((s) => rampStopColor(s.color)),
      ordered.map((s) => s.position),
      steps,
    ).map((c) => toHex(c));
  };

  const orderedStops = (stops: CustomPaletteStop[]): CustomPaletteStop[] =>
    reversed ? reversedStops(stops) : stops;

  const groups: Palette["group"][] = numeric
    ? (["sequential", "diverging"] as Palette["group"][]).filter(
        (g) => filter === "all" || g === filter,
      )
    : ["qualitative"];

  const listFor = (group: Palette["group"]) =>
    PALETTES.filter(
      (p) =>
        p.kind === kind &&
        p.group === group &&
        (!anySafe || !safeOnly || p.colorblindSafe),
    );

  const pick = (name: string) => {
    setOpen(false);
    if (name !== palette) onChange({ palette: name });
  };

  const removeCustom = async (name: string) => {
    try {
      await fetch(`/api/palettes/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    } finally {
      void refreshCustom();
    }
  };

  const editStop = (index: number, patch: Partial<CustomPaletteStop>) => {
    setDraft((d) =>
      d.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
    setEditorError(null);
  };

  const addStop = () => {
    setDraft((d) => {
      if (d.length >= 16) return d;
      // Insert into the widest gap, colored by its midpoint neighbors.
      let gi = 0;
      for (let i = 0; i < d.length - 1; i++) {
        if (d[i + 1].position - d[i].position > d[gi + 1].position - d[gi].position)
          gi = i;
      }
      const position = (d[gi].position + d[gi + 1].position) / 2;
      const color = toHex(
        rampColors(
          d.map((s) => rampStopColor(s.color)),
          d.map((s) => s.position),
          3,
        )[1],
      );
      return [
        ...d.slice(0, gi + 1),
        { color, position },
        ...d.slice(gi + 1),
      ];
    });
  };

  const removeStop = (index: number) => {
    setDraft((d) => (d.length > 2 ? d.filter((_, i) => i !== index) : d));
  };

  const saveDraft = async () => {
    const label = draftName.trim() || "My palette";
    const stops = [...draft].sort((a, b) => a.position - b.position);
    try {
      const response = await fetch("/api/palettes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, stops }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setEditorError(body?.error?.message ?? "Could not save the palette.");
        return;
      }
      const saved = (await response.json()) as CustomPalette;
      setEditing(false);
      setDraftName("");
      setDraft(DRAFT_STOPS);
      setEditorError(null);
      await refreshCustom();
      pick(saved.name);
    } catch {
      setEditorError("Could not save the palette.");
    }
  };

  const activeLabel = active?.label ?? activeCustom?.label ?? "Custom";

  return (
    <div className={styles.control} ref={rootRef}>
      <button
        ref={headRef}
        type="button"
        className={styles.head}
        data-open={open}
        disabled={disabled}
        {...popoverTriggerProps(panelId, open)}
        title={activeLabel}
        aria-label={`${name}: ${activeLabel}`}
        onClick={() => {
          // Saved palettes refresh on open — event-driven, not an effect.
          if (!open && numeric) void refreshCustom();
          setOpen((v) => !v);
        }}
      >
        <span className={styles.headName}>{activeLabel}</span>
        {continuous && active ? (
          <GradientStrip
            className={styles.gradStrip}
            stops={orderedStops(evenStops(active.colors))}
          />
        ) : continuous && activeCustom ? (
          <GradientStrip
            className={styles.gradStrip}
            stops={orderedStops(activeCustom.stops)}
          />
        ) : active ? (
          <Strip className={styles.strip} colors={strip(active)} />
        ) : activeCustom ? (
          <Strip className={styles.strip} colors={customStrip(activeCustom)} />
        ) : (
          <Strip className={styles.strip} colors={currentColors} />
        )}
        <span className={styles.chevron} aria-hidden>
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <div className={styles.browser} id={panelId} role="group" aria-label="Palettes">
          {numeric && (
            <div className={styles.filters}>
              {RAMP_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={styles.filterBtn}
                  data-active={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {numeric && !continuous && (
            <div className={styles.optionRow}>
              <span className={styles.optionLabel}>Steps</span>
              <Select
                className={styles.select}
                aria-label="Steps"
                value={steps}
                disabled={disabled}
                onChange={(e) => onChange({ classes: Number(e.target.value) })}
              >
                {STEP_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className={styles.toggles}>
            <SwitchRow
              className={styles.checkRow}
              checked={reversed}
              disabled={disabled}
              onChange={(e) => onChange({ reversed: e.target.checked })}
              label="Reversed"
            />
            {anySafe && (
              <SwitchRow
                className={styles.checkRow}
                checked={safeOnly}
                onChange={(e) => setSafeOnly(e.target.checked)}
                label="Colorblind safe"
              />
            )}
          </div>

          <div className={styles.list}>
            {groups.map((group) => {
              const palettes = listFor(group);
              if (palettes.length === 0) return null;
              return (
                <div key={group} className={styles.groupBlock}>
                  <div className={styles.groupHeading}>{GROUP_LABELS[group]}</div>
                  {palettes.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className={styles.item}
                      data-active={p.name === palette}
                      disabled={disabled}
                      onClick={() => pick(p.name)}
                    >
                      <span className={styles.itemName}>{p.label}</span>
                      {continuous ? (
                        <GradientStrip
                          className={styles.itemGradStrip}
                          stops={orderedStops(evenStops(p.colors))}
                        />
                      ) : (
                        <Strip className={styles.itemStrip} colors={strip(p)} />
                      )}
                    </button>
                  ))}
                </div>
              );
            })}

            {numeric && (filter === "all" || custom.length > 0) && (
              <div className={styles.groupBlock}>
                <div className={styles.groupHeading}>Your palettes</div>
                {custom.length === 0 && (
                  <p className={styles.emptyHint}>none yet</p>
                )}
                {custom.map((p) => (
                  <div key={p.name} className={styles.customRow}>
                    <button
                      type="button"
                      className={styles.item}
                      data-active={p.name === palette}
                      disabled={disabled}
                      onClick={() => pick(p.name)}
                    >
                      <span className={styles.itemName}>{p.label}</span>
                      {continuous ? (
                        <GradientStrip
                          className={styles.itemGradStrip}
                          stops={orderedStops(p.stops)}
                        />
                      ) : (
                        <Strip
                          className={styles.itemStrip}
                          colors={customStrip(p)}
                        />
                      )}
                    </button>
                    <IconButton
                      className={styles.itemDelete}
                      tone="danger"
                      action={`Delete palette ${p.label}`}
                      icon={<XIcon />}
                      disabled={disabled}
                      onClick={() => void removeCustom(p.name)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {numeric && !editing && (
            <button
              type="button"
              className={styles.newBtn}
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              <PlusIcon /> New palette
            </button>
          )}

          {numeric && editing && (
            <div className={styles.editor}>
              <GradientStrip
                className={styles.editorStrip}
                stops={[...draft].sort((a, b) => a.position - b.position)}
              />
              {draft.map((s, i) => (
                <div key={i} className={styles.editorRow}>
                  <input
                    type="color"
                    className={styles.stopColor}
                    aria-label={`Stop ${i + 1} color`}
                    value={s.color}
                    onChange={(e) => editStop(i, { color: e.target.value })}
                  />
                  <NumberInput
                    className={styles.stopPos}
                    aria-label={`Stop ${i + 1} position (%)`}
                    min={0}
                    max={100}
                    value={Math.round(s.position * 100)}
                    onChange={(e) =>
                      editStop(i, {
                        position:
                          Math.min(100, Math.max(0, Number(e.target.value))) /
                          100,
                      })
                    }
                  />
                  <span className={styles.stopPct}>%</span>
                  <IconButton
                    className={styles.stopRemove}
                    tone="danger"
                    action="Remove this stop"
                    icon={<XIcon />}
                    disabled={draft.length <= 2}
                    onClick={() => removeStop(i)}
                  />
                </div>
              ))}
              <button
                type="button"
                className={styles.addStop}
                disabled={draft.length >= 16}
                onClick={addStop}
              >
                <PlusIcon /> add stop
              </button>
              <div className={styles.saveRow}>
                <TextInput
                  className={styles.saveName}
                  aria-label="Name this palette"
                  placeholder="Save as…"
                  maxLength={60}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={() => void saveDraft()}
                >
                  Save
                </button>
              </div>
              {editorError && (
                <ErrorNote
                  message={editorError}
                  onDismiss={() => setEditorError(null)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

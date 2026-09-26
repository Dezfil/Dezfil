"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Layer } from "@/lib/metadata/maps";
import type { FieldStats, LayerField } from "@/lib/layer-service";
import { isAggregated, type LayerFilter } from "@/lib/viz";
import type { MapTimeline } from "@/lib/timeline";
import { windowToRange } from "@/lib/time";
import { SearchIcon, TimelineIcon, TrashIcon } from "../ui/icons";
import { IconButton } from "../ui/IconButton";
import { popoverTriggerProps, usePopoverDismiss } from "../ui/Popover";
import { CollapsibleSection } from "./CollapsibleSection";
import { NumericControl } from "./filters/NumericControl";
import { RangeBrush } from "./filters/RangeBrush";
import styles from "./FilterSection.module.css";

interface Props {
  layer: Layer;
  /** The layer's filterable (base) fields. */
  fields: LayerField[];
  onFilters: (filters: LayerFilter[]) => Promise<boolean>;
  /** The map's docked timeline; a time filter row offers to
   * dock itself when the handlers are wired. */
  timeline?: MapTimeline | null;
  onDock?: (field: string) => void;
  onUndock?: () => void;
  /** Live filtering: fields the canvas enforces client-side —
   * their brushes drive the map mid-drag through the preview channel. */
  liveFields?: string[];
  onLivePreview?: (field: string, range: [number, number]) => void;
  onLivePreviewStart?: () => void;
  onLivePreviewEnd?: (accepted: boolean) => void;
  /** Worker fallback for aggregated and otherwise non-delegated sliders. */
  onQueryPreview?: (filters: LayerFilter[]) => void;
  onQueryPreviewStart?: () => void;
  onQueryPreviewEnd?: (accepted: boolean) => void;
}

/** Search and select-all controls appear past this many listed values. */
const LONG_VALUE_LIST = 8;

/** The badge text a field shows in the picker and on its filter card. */
function typeBadge(field: LayerField): string {
  if (field.kind === "numeric") return /INT/.test(field.type) ? "int" : "float";
  if (field.kind === "time") return field.type.startsWith("DATE") ? "date" : "time";
  return "text";
}

/**
 * Per-layer filters: the control matches the field's kind — numeric and time
 * fields brush a range over the field's distribution, text fields pick
 * values — seeded from the data's real extent, applied before aggregation,
 * removable without touching the layer's SQL.
 */
export function FilterSection({
  layer,
  fields,
  onFilters,
  timeline = null,
  onDock,
  onUndock,
  liveFields,
  onLivePreview,
  onLivePreviewStart,
  onLivePreviewEnd,
  onQueryPreview,
  onQueryPreviewStart,
  onQueryPreviewEnd,
}: Props) {
  const [stats, setStats] = useState<Record<string, FieldStats>>({});
  const filters = layer.filters;
  // Playback needs real features to window — aggregated cells have
  // none; their time filter keeps working without the dock.
  const dockable = !!onDock && !isAggregated(layer.viz);
  const liveSet = new Set(liveFields ?? []);
  const liveFor = (field: string) =>
    onLivePreview && liveSet.has(field)
      ? (range: [number, number]) => onLivePreview(field, range)
      : undefined;
  const liveStartFor = (field: string) =>
    liveSet.has(field) ? onLivePreviewStart : undefined;
  const liveEndFor = (field: string) =>
    liveSet.has(field) ? onLivePreviewEnd : undefined;
  const queryFor = (index: number, field: string) =>
    !liveSet.has(field) && onQueryPreview
      ? (next: LayerFilter) =>
          onQueryPreview(filters.map((f, i) => (i === index ? next : f)))
      : undefined;
  const queryStartFor = (field: string) =>
    !liveSet.has(field) ? onQueryPreviewStart : undefined;
  const queryEndFor = (field: string) =>
    !liveSet.has(field) ? onQueryPreviewEnd : undefined;

  // Every control draws on its field's stats (extent, distribution, or
  // values); fetch stats for any filtered field we have not seeded yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const f of filters) {
        if (stats[f.field]) continue;
        const response = await fetch(
          `/api/layers/${layer.id}/fields/${encodeURIComponent(f.field)}`,
        );
        if (!response.ok || cancelled) continue;
        const s = (await response.json()) as FieldStats;
        if (!cancelled) setStats((prev) => ({ ...prev, [f.field]: s }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, layer.id, stats]);

  const addFilter = async (field: LayerField) => {
    const response = await fetch(
      `/api/layers/${layer.id}/fields/${encodeURIComponent(field.name)}`,
    );
    if (!response.ok) return;
    const s = (await response.json()) as FieldStats;
    setStats((prev) => ({ ...prev, [field.name]: s }));
    const next: LayerFilter =
      s.kind === "numeric"
        ? { field: field.name, kind: "range", min: s.min, max: s.max }
        : s.kind === "time"
          ? { field: field.name, kind: "timerange", min: s.min, max: s.max }
          : { field: field.name, kind: "values", values: s.values };
    await onFilters([...filters, next]);
  };

  const update = (index: number, f: LayerFilter) =>
    onFilters(filters.map((x, i) => (i === index ? f : x)));
  const remove = (index: number) => {
    void onFilters(filters.filter((_, i) => i !== index));
  };

  const available = fields.filter(
    (f) => !filters.some((fl) => fl.field === f.name),
  );

  return (
    <CollapsibleSection layerId={layer.id} name="filters" label="Filters">

      {filters.map((f, i) => {
        const field = fields.find((x) => x.name === f.field);
        return (
          <div key={`${f.field}:${i}`} className={styles.filter}>
            <div className={styles.filterHead}>
              <span className={styles.headLeft}>
                {field && (
                  <span className={styles.badge} data-kind={field.kind}>
                    {typeBadge(field)}
                  </span>
                )}
                <span className={styles.fieldName}>{f.field}</span>
              </span>
              {f.kind === "timerange" &&
                dockable &&
                (() => {
                  const docked =
                    timeline?.layerId === layer.id &&
                    timeline.field === f.field;
                  return (
                    <button
                      className={styles.playback}
                      data-active={docked}
                      aria-label={
                        docked ? "Collapse timeline" : "Show on map timeline"
                      }
                      aria-pressed={docked}
                      title={
                        docked
                          ? "Collapse the map timeline"
                          : "Play this filter on the map timeline"
                      }
                      onClick={() =>
                        docked ? onUndock?.() : onDock?.(f.field)
                      }
                    >
                      <TimelineIcon /> Playback
                    </button>
                  );
                })()}
              <IconButton
                className={styles.remove}
                tone="danger"
                action="Remove filter"
                icon={<TrashIcon />}
                onClick={() => remove(i)}
              />
            </div>
            {f.kind === "range" ? (
              <NumericControl
                filter={f}
                stats={stats[f.field]}
                columnType={field?.type}
                onChange={(next) => update(i, next)}
                onLive={liveFor(f.field)}
                onLiveStart={liveStartFor(f.field)}
                onLiveEnd={liveEndFor(f.field)}
                onFilterPreview={queryFor(i, f.field)}
                onFilterPreviewStart={queryStartFor(f.field)}
                onFilterPreviewEnd={queryEndFor(f.field)}
              />
            ) : f.kind === "timerange" ? (
              <TimeControl
                filter={f}
                stats={stats[f.field]}
                docked={
                  timeline?.layerId === layer.id && timeline.field === f.field
                }
                onChange={(next) => update(i, next)}
                onLive={liveFor(f.field)}
                onLiveStart={liveStartFor(f.field)}
                onLiveEnd={liveEndFor(f.field)}
                onFilterPreview={queryFor(i, f.field)}
                onFilterPreviewStart={queryStartFor(f.field)}
                onFilterPreviewEnd={queryEndFor(f.field)}
              />
            ) : (
              <ValuesControl
                filter={f}
                stats={stats[f.field]}
                onChange={(next) => void update(i, next)}
              />
            )}
          </div>
        );
      })}

      {available.length > 0 && (
        <AddFilterPicker fields={available} onPick={(f) => void addFilter(f)} />
      )}
    </CollapsibleSection>
  );
}

/** Searchable field picker with kind badges.
 * Trigger and dismissal are the kit's popover contract (adopted here per
 * the ruling): the trigger stays mounted and states the relationship,
 * Escape dismisses from anywhere inside and returns focus to it, an
 * outside pointer dismisses without stealing its target's focus. */
function AddFilterPicker({
  fields,
  onPick,
}: {
  fields: LayerField[];
  onPick: (f: LayerField) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  usePopoverDismiss({
    open,
    onClose: () => setOpen(false),
    contentRef: panelRef,
    triggerRef,
  });
  const q = query.trim().toLowerCase();
  const shown = q ? fields.filter((f) => f.name.toLowerCase().includes(q)) : fields;
  return (
    <div className={styles.pickerWrap}>
      <button
        ref={triggerRef}
        className={styles.add}
        {...popoverTriggerProps(panelId, open)}
        onClick={() => {
          setQuery("");
          setOpen((o) => !o);
        }}
      >
        + Add filter
      </button>
      {open && (
        <div className={styles.picker} id={panelId} ref={panelRef}>
          <div className={styles.searchRow}>
            <SearchIcon />
            <input
              className={styles.search}
              placeholder="Search fields…"
              aria-label="Search fields"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className={styles.options}>
            {shown.map((f) => (
              <li key={f.name}>
                <button
                  className={styles.option}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                    onPick(f);
                  }}
                >
                  <span className={styles.badge} data-kind={f.kind}>
                    {typeBadge(f)}
                  </span>
                  <span className={styles.optionName}>{f.name}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className={styles.noMatch}>No matching fields</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}


// Time bounds travel as ISO strings without timezone; the brush does its
// math in epoch milliseconds under one fixed convention (UTC) at both ends,
// so nothing shifts (plan: timestamp correctness).
function isoToMs(iso: string): number {
  const t =
    iso.length === 10 ? `${iso}T00:00:00` : iso.includes("T") ? iso : iso.replace(" ", "T");
  return Date.parse(`${t}Z`);
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function TimeControl({
  filter,
  stats,
  docked = false,
  onChange,
  onLive,
  onLiveStart,
  onLiveEnd,
  onFilterPreview,
  onFilterPreviewStart,
  onFilterPreviewEnd,
}: {
  filter: Extract<LayerFilter, { kind: "timerange" }>;
  stats?: FieldStats;
  /** Docked to the map timeline: the widget is the brush,
   * so the row keeps only its precise bound inputs. */
  docked?: boolean;
  onChange: (f: LayerFilter) => Promise<boolean>;
  /** Live preview channel, in epoch-ms GPU range terms. */
  onLive?: (range: [number, number]) => void;
  onLiveStart?: () => void;
  onLiveEnd?: (accepted: boolean) => void;
  onFilterPreview?: (filter: LayerFilter) => void;
  onFilterPreviewStart?: () => void;
  onFilterPreviewEnd?: (accepted: boolean) => void;
}) {
  const extent = stats?.kind === "time" ? stats : null;
  const from = extent?.min != null ? isoToMs(extent.min) : null;
  const to = extent?.max != null ? isoToMs(extent.max) : null;
  const brushable =
    from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to) && from < to;
  const [sel, setSel] = useState<[number, number]>([
    filter.min !== null ? isoToMs(filter.min) : (from ?? 0),
    filter.max !== null ? isoToMs(filter.max) : (to ?? 0),
  ]);
  const selRef = useRef(sel);
  const [minText, setMinText] = useState(filter.min ?? "");
  const [maxText, setMaxText] = useState(filter.max ?? "");
  const minTextRef = useRef(minText);
  const maxTextRef = useRef(maxText);
  const authoritativeRef = useRef(filter);
  const localRef = useRef(false);
  const pendingRef = useRef(0);
  const generationRef = useRef(0);

  useEffect(() => {
    authoritativeRef.current = filter;
    if (localRef.current || pendingRef.current > 0) return;
    const next: [number, number] = [
      filter.min !== null ? isoToMs(filter.min) : (from ?? 0),
      filter.max !== null ? isoToMs(filter.max) : (to ?? 0),
    ];
    selRef.current = next;
    setSel(next);
    const nextMinText = filter.min ?? "";
    const nextMaxText = filter.max ?? "";
    minTextRef.current = nextMinText;
    maxTextRef.current = nextMaxText;
    setMinText(nextMinText);
    setMaxText(nextMaxText);
  }, [filter, from, to]);

  if (!stats) return <span className={styles.loading}>Loading…</span>;

  const beginInteraction = () => {
    localRef.current = true;
    generationRef.current += 1;
    onLiveStart?.();
    onFilterPreviewStart?.();
  };

  const resetToAuthoritative = () => {
    const current = authoritativeRef.current;
    const next: [number, number] = [
      current.min !== null ? isoToMs(current.min) : (from ?? 0),
      current.max !== null ? isoToMs(current.max) : (to ?? 0),
    ];
    selRef.current = next;
    setSel(next);
    const nextMinText = current.min ?? "";
    const nextMaxText = current.max ?? "";
    minTextRef.current = nextMinText;
    maxTextRef.current = nextMaxText;
    setMinText(nextMinText);
    setMaxText(nextMaxText);
    onLive?.(next);
  };

  const commitSel = async () => {
    if (from === null || to === null) return;
    const generation = generationRef.current;
    localRef.current = false;
    pendingRef.current += 1;
    const min = selRef.current[0] <= from ? null : msToIso(selRef.current[0]);
    const max = selRef.current[1] >= to ? null : msToIso(selRef.current[1]);
    let accepted = false;
    try {
      accepted =
        min === filter.min && max === filter.max
          ? true
          : await onChange({ ...filter, min, max });
    } catch {
      accepted = false;
    } finally {
      pendingRef.current -= 1;
    }
    if (generation !== generationRef.current || localRef.current) return;
    if (accepted) {
      const nextMinText = min ?? "";
      const nextMaxText = max ?? "";
      minTextRef.current = nextMinText;
      maxTextRef.current = nextMaxText;
      setMinText(nextMinText);
      setMaxText(nextMaxText);
    } else {
      resetToAuthoritative();
    }
    onLiveEnd?.(accepted);
    onFilterPreviewEnd?.(accepted);
  };

  const commitText = async () => {
    const parse = (s: string) => {
      const t = s.trim();
      return t !== "" && Number.isFinite(isoToMs(t)) ? t : null;
    };
    const min = parse(minTextRef.current);
    const max = parse(maxTextRef.current);
    const accepted = await onChange({
      ...filter,
      min,
      max,
    });
    if (accepted) {
      const next: [number, number] = [
        min !== null ? isoToMs(min) : (from ?? 0),
        max !== null ? isoToMs(max) : (to ?? 0),
      ];
      selRef.current = next;
      setSel(next);
    } else {
      resetToAuthoritative();
    }
  };

  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  // Mid-drag: the map windows live; extent-edge bounds preview as open,
  // matching what the commit stores (see NumericControl).
  const livePreview = (next: [number, number]) => {
    selRef.current = next;
    setSel(next);
    if (onLive && from !== null && to !== null) {
      onLive(
        windowToRange([
          next[0] <= from ? null : next[0],
          next[1] >= to ? null : next[1],
        ]),
      );
    }
    if (onFilterPreview && from !== null && to !== null) {
      onFilterPreview({
        ...filter,
        min: next[0] <= from ? null : msToIso(next[0]),
        max: next[1] >= to ? null : msToIso(next[1]),
      });
    }
  };

  return (
    <>
      {brushable && !docked && (
        <RangeBrush
          from={from}
          to={to}
          sel={sel}
          step={(to - from || 1) / 200}
          bins={extent?.bins ?? []}
          onPreview={livePreview}
          onStart={beginInteraction}
          onCommit={commitSel}
        />
      )}
      <div className={styles.range}>
        <input
          className={styles.bound}
          type="text"
          value={minText}
          placeholder={extent?.min ?? "from"}
          aria-label={`${filter.field} start`}
          onChange={(e) => {
            minTextRef.current = e.target.value;
            setMinText(e.target.value);
          }}
          onBlur={() => void commitText()}
          onKeyDown={blurOnEnter}
        />
        <span className={styles.to}>–</span>
        <input
          className={styles.bound}
          type="text"
          value={maxText}
          placeholder={extent?.max ?? "to"}
          aria-label={`${filter.field} end`}
          onChange={(e) => {
            maxTextRef.current = e.target.value;
            setMaxText(e.target.value);
          }}
          onBlur={() => void commitText()}
          onKeyDown={blurOnEnter}
        />
      </div>
    </>
  );
}

function ValuesControl({
  filter,
  stats,
  onChange,
}: {
  filter: Extract<LayerFilter, { kind: "values" }>;
  stats?: FieldStats;
  onChange: (f: LayerFilter) => void;
}) {
  const [query, setQuery] = useState("");
  // Options: the field's actual values, plus any selected value the bounded
  // list no longer contains (so it stays visible and un-checkable).
  const listed = stats?.kind === "text" ? stats.values : [];
  const options = [...listed, ...filter.values.filter((v) => !listed.includes(v))];
  const selected = new Set(filter.values);
  const long = options.length > LONG_VALUE_LIST;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((v) => v.toLowerCase().includes(q)) : options;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...filter, values: options.filter((v) => next.has(v)) });
  };

  // All/none act on what the search shows, so a narrowed list can be
  // selected in one click without disturbing the rest.
  const selectShown = (on: boolean) => {
    const next = new Set(selected);
    for (const v of shown) {
      if (on) next.add(v);
      else next.delete(v);
    }
    onChange({ ...filter, values: options.filter((v) => next.has(v)) });
  };

  if (options.length === 0) {
    return <span className={styles.loading}>Loading values…</span>;
  }

  return (
    <div className={styles.values}>
      {long && (
        <div className={styles.valuesTools}>
          <input
            className={styles.valuesSearch}
            placeholder="Search values…"
            aria-label={`Search ${filter.field} values`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className={styles.toolBtn} onClick={() => selectShown(true)}>
            All
          </button>
          <button className={styles.toolBtn} onClick={() => selectShown(false)}>
            None
          </button>
        </div>
      )}
      <div className={styles.valueList}>
        {shown.map((v) => (
          <label key={v} className={styles.valueRow}>
            <input
              type="checkbox"
              checked={selected.has(v)}
              onChange={() => toggle(v)}
            />
            <span className={styles.valueText}>{v}</span>
          </label>
        ))}
        {shown.length === 0 && (
          <span className={styles.noMatch}>No matching values</span>
        )}
      </div>
      {stats?.kind === "text" && stats.truncated && (
        <span className={styles.truncated}>
          only the most frequent values are listed
        </span>
      )}
    </div>
  );
}

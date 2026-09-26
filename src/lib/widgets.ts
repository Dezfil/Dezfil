import type { LayerFilter } from "@/lib/viz";

/**
 * Dashboard cards: the map holds one ordered list of widgets — formula,
 * category, histogram, and note — rendered as cards on the rail.
 * Data-bearing types are computed server-side over their layer's effective
 * query; notes are authored text. Widget *selections* are the ephemeral
 * half: session-local view state, never persisted, carried on requests and
 * compiled through the same filter machinery as stored filters. This
 * module is the one place that defines both shapes and their validation,
 * so the builder, the viewer, and the API cannot drift.
 */

export const WIDGET_TYPES = ["formula", "category", "histogram", "note"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_AGGS = ["count", "sum", "avg", "min", "max"] as const;
export type WidgetAgg = (typeof WIDGET_AGGS)[number];

/** Ranking aggregates a category widget supports (spec: count, sum, avg). */
export const CATEGORY_AGGS = ["count", "sum", "avg"] as const;

/** How a formula's number renders; null = automatic. */
export const WIDGET_FORMATS = [
  "compact",
  "percent",
  "percent2",
  "integer",
  "decimal1",
  "decimal2",
] as const;
export type WidgetFormat = (typeof WIDGET_FORMATS)[number];

export interface MapWidget {
  id: string;
  type: WidgetType;
  /** The layer the widget reads — and the only layer its selection
   * filters. Null exactly for notes, which read nothing. */
  layerId: string | null;
  /** Card heading; always present. */
  title: string;
  /**
   * formula: the aggregated field (null = count of rows);
   * category: the grouping field; histogram: the numeric field;
   * note: always null.
   */
  field: string | null;
  /** Formula value / category ranking aggregate; others ignore it. */
  agg: WidgetAgg;
  /** Category only: the field a sum/avg ranking aggregates (null = count). */
  aggField: string | null;
  /** Formula: unit text after the number; null = none. */
  unit: string | null;
  /** Formula: caption under the number; note: the body text. */
  note: string | null;
  /** Formula: number formatting; null = automatic. */
  format: WidgetFormat | null;
  /** Hidden widgets keep their config but leave the rail. */
  visible: boolean;
}

export const MAX_WIDGETS = 12;
export const WIDGET_TITLE_MAX = 60;
export const WIDGET_UNIT_MAX = 20;
/** Formula captions and note bodies share the note bound. */
export const WIDGET_NOTE_MAX = 2000;
/** Categories shown before the Other rollup (spec: top 5 + Other, fixed). */
export const CATEGORY_TOP_N = 5;
/** Bars in a histogram widget — the rail card's fixed resolution. */
export const WIDGET_HISTOGRAM_BINS = 24;
/** Most categories a single selection can hold (top-N sized, with slack). */
export const MAX_SELECTION_VALUES = 50;

function isWidget(value: unknown): value is MapWidget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  if (typeof w.id !== "string" || w.id.length === 0) return false;
  if (!WIDGET_TYPES.includes(w.type as WidgetType)) return false;
  if (
    typeof w.title !== "string" ||
    w.title.trim().length === 0 ||
    w.title.length > WIDGET_TITLE_MAX
  ) {
    return false;
  }
  if (typeof w.visible !== "boolean") return false;
  if (!WIDGET_AGGS.includes(w.agg as WidgetAgg)) return false;
  const isName = (v: unknown) => typeof v === "string" && v.length > 0;
  const text = (v: unknown, max: number) =>
    v === null || (typeof v === "string" && v.length > 0 && v.length <= max);
  if (w.note !== null && typeof w.note !== "string") return false;
  if (
    w.type === "note"
      ? w.layerId !== null
      : !isName(w.layerId)
  ) {
    return false;
  }
  if (w.type === "note") {
    // A note is a title and a body; nothing else applies.
    return (
      typeof w.note === "string" &&
      w.note.trim().length > 0 &&
      w.note.length <= WIDGET_NOTE_MAX &&
      w.field === null &&
      w.agg === "count" &&
      w.aggField === null &&
      w.unit === null &&
      w.format === null
    );
  }
  if (!text(w.note, WIDGET_NOTE_MAX)) return false;
  if (w.type === "formula") {
    // count aggregates rows (no field); everything else aggregates a field.
    if (w.agg === "count" ? w.field !== null : !isName(w.field)) return false;
    return (
      w.aggField === null &&
      text(w.unit, WIDGET_UNIT_MAX) &&
      (w.format === null || WIDGET_FORMATS.includes(w.format as WidgetFormat))
    );
  }
  // Category and histogram carry no formula presentation fields.
  if (w.unit !== null || w.format !== null || w.note !== null) return false;
  if (w.type === "category") {
    if (!isName(w.field)) return false;
    if (!CATEGORY_AGGS.includes(w.agg as (typeof CATEGORY_AGGS)[number])) {
      return false;
    }
    return w.agg === "count" ? w.aggField === null : isName(w.aggField);
  }
  // histogram: a numeric field; the aggregate is not part of the config.
  return isName(w.field) && w.agg === "count" && w.aggField === null;
}

export function isValidWidgets(value: unknown): value is MapWidget[] {
  if (!Array.isArray(value) || value.length > MAX_WIDGETS) return false;
  if (!value.every(isWidget)) return false;
  return new Set(value.map((w) => (w as MapWidget).id)).size === value.length;
}

/** A widget that reads data (everything but a note). */
export function isDataWidget(
  w: MapWidget,
): w is MapWidget & { layerId: string } {
  return w.type !== "note";
}

// formula number formatting ----

/** Render a formula value under the widget's format; automatic (null)
 * keeps the compact-ish default. Shared by builder and viewer. */
export function formatWidgetNumber(
  n: number | null,
  format: WidgetFormat | null,
): string {
  if (n === null || !Number.isFinite(n)) return "—";
  switch (format) {
    case "compact":
      return Math.abs(n) >= 1000
        ? new Intl.NumberFormat("en", {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(n)
        : String(Math.round(n * 100) / 100);
    case "percent":
      return `${(n * 100).toFixed(1)}%`;
    case "percent2":
      return `${(n * 100).toFixed(2)}%`;
    case "integer":
      return Math.round(n).toLocaleString("en");
    case "decimal1":
      return n.toLocaleString("en", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
    case "decimal2":
      return n.toLocaleString("en", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    default: {
      const abs = Math.abs(n);
      if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
      if (Number.isInteger(n)) return n.toLocaleString("en");
      return abs >= 100 ? n.toFixed(0) : n.toFixed(abs >= 1 ? 1 : 2);
    }
  }
}

// ---- selections (ephemeral; never stored) ----

/**
 * One widget's active selection. The field is deliberately absent — the
 * server resolves it from the stored widget, so a request can never point
 * a selection at an arbitrary column. Category selections are an
 * EXCLUSION set: all categories active by default, each deactivation
 * names one; Other and unlisted categories stay in.
 */
export type WidgetSelection =
  | { widgetId: string; kind: "exclude"; values: string[] }
  | { widgetId: string; kind: "range"; min: number | null; max: number | null };

function isSelection(value: unknown): value is WidgetSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.widgetId !== "string" || s.widgetId.length === 0) return false;
  if (s.kind === "exclude") {
    return (
      Array.isArray(s.values) &&
      s.values.length > 0 &&
      s.values.length <= MAX_SELECTION_VALUES &&
      s.values.every((v) => typeof v === "string")
    );
  }
  if (s.kind === "range") {
    const bound = (b: unknown) =>
      b === null || (typeof b === "number" && Number.isFinite(b));
    return bound(s.min) && bound(s.max);
  }
  return false;
}

export function isValidSelections(value: unknown): value is WidgetSelection[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_WIDGETS &&
    value.every(isSelection) &&
    new Set(value.map((s) => (s as WidgetSelection).widgetId)).size ===
      value.length
  );
}

/**
 * A selection as the filter it means, resolved against its widget — the one
 * translation between the ephemeral and stored filter worlds. Returns null
 * when the selection cannot apply (unknown widget, kind mismatch, or a
 * widget without a field): unresolvable selections filter nothing rather
 * than something surprising.
 */
export function selectionFilter(
  selection: WidgetSelection,
  widget: MapWidget | undefined,
): LayerFilter | null {
  if (!widget || widget.field === null) return null;
  if (selection.kind === "exclude") {
    if (widget.type !== "category") return null;
    return {
      field: widget.field,
      kind: "values",
      values: selection.values,
      exclude: true,
    };
  }
  if (widget.type !== "histogram") return null;
  return {
    field: widget.field,
    kind: "range",
    min: selection.min,
    max: selection.max,
  };
}

/**
 * The filters a set of selections imposes on one layer, excluding a widget's
 * own selection (classic crossfilter: a widget never filters itself). Pass
 * `exceptWidgetId: null` for the map itself, which every selection filters.
 */
export function selectionFilters(
  selections: WidgetSelection[],
  widgets: MapWidget[],
  layerId: string,
  exceptWidgetId: string | null,
): LayerFilter[] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const out: LayerFilter[] = [];
  for (const s of selections) {
    if (s.widgetId === exceptWidgetId) continue;
    const widget = byId.get(s.widgetId);
    if (!widget || widget.layerId !== layerId) continue;
    const filter = selectionFilter(s, widget);
    if (filter) out.push(filter);
  }
  return out;
}

/** A stored widget read back without the fields (or a note
 * migrated by SQL, which cannot know the newer optional keys). */
export function normalizeWidget(w: MapWidget): MapWidget {
  return {
    ...w,
    unit: w.unit ?? null,
    note: w.note ?? null,
    format: w.format ?? null,
  };
}

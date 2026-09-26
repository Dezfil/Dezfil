import { boundedEvaluation, isOutOfMemory } from "@/lib/query/bounded";
import { filteredSql } from "@/lib/query/compile";
import {
  baseFields,
  renderLayer,
  type LayerRenderData,
  type RenderLayerOpts,
} from "@/lib/layer-service";
import { publishedFieldsFor } from "@/lib/publish/published-fields";
import { ApiError, EvaluationCancelled, type ErrorCode } from "@/lib/api/errors";
import type { Layer, MapRecord } from "@/lib/metadata/maps";
import { isAggregated, type LayerFilter } from "@/lib/viz";
import {
  selectionFilter,
  selectionFilters,
  isDataWidget,
  CATEGORY_TOP_N,
  WIDGET_HISTOGRAM_BINS,
  type MapWidget,
  type WidgetSelection,
} from "@/lib/widgets";

/**
 * Widget values, computed server-side in one batched call. Every widget
 * composes on the effective-query seam — layer SQL → stored filters → the
 * *other* widgets' selections (classic crossfilter: a widget never filters
 * itself) — through the same compilation and escaping as stored filters, on
 * the hardened read-only connection. Selections arrive with the request and
 * are never persisted; the field a selection filters comes from the stored
 * widget, never from the request.
 */

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export type WidgetValue =
  | {
      id: string;
      type: "formula";
      /** The constrained value; null when the query matched no rows. */
      value: number | null;
      /** The selection-free value — "filtered from …". Equals `value`
       * when no other widget constrains this one. */
      baseline: number | null;
    }
  | {
      id: string;
      type: "category";
      categories: { value: string; n: number }[];
      /** The rollup beyond the top categories; null when nothing rolls up. */
      other: number | null;
    }
  | {
      id: string;
      type: "histogram";
      /** Bin domain from the selection-free query — stable while
       * cross-filtered, so bars shrink in place. Null when the field has
       * no extent (empty result or a single value). */
      domain: { min: number; max: number } | null;
      /** Constrained row counts over equal-width bins across the domain. */
      bins: number[];
    }
  | {
      id: string;
      /** The widget could not compute — its layer is gone or its query
       * failed. The rest of the dashboard keeps working. */
      error: string;
      /** Machine-readable reason — truth surfaces key their
       * prose on it; the message stays for authenticated detail. */
      errorCode: ErrorCode;
    };

export interface WidgetLayerCount {
  layerId: string;
  /** Rows under stored filters plus every selection on the layer. */
  count: number;
  /** Rows under stored filters alone. */
  total: number;
}

export interface WidgetValues {
  widgets: WidgetValue[];
  layers: WidgetLayerCount[];
}

type Conn = Parameters<Parameters<typeof boundedEvaluation>[0]>[0];

async function scalar(conn: Conn, sql: string): Promise<number | null> {
  const reader = await conn.runAndReadAll(sql);
  const row = reader.getRowObjects()[0] as { v: unknown } | undefined;
  const n = Number(row?.v);
  return row?.v == null || !Number.isFinite(n) ? null : n;
}

function aggExpr(agg: MapWidget["agg"], field: string | null): string {
  if (agg === "count" || field === null) return "count(*)";
  return `${agg}(${ident(field)}::DOUBLE)`;
}

function sub(sql: string, filters: LayerFilter[]): string {
  return `(${filteredSql(sql, filters)}) AS q`;
}

async function formulaValue(
  conn: Conn,
  widget: MapWidget & { type: "formula" },
  layer: Layer,
  constrained: LayerFilter[],
): Promise<WidgetValue> {
  const expr = aggExpr(widget.agg, widget.field);
  const base = [...layer.filters];
  const value = await scalar(
    conn,
    `SELECT ${expr} AS v FROM ${sub(layer.sql, [...base, ...constrained])}`,
  );
  const baseline =
    constrained.length === 0
      ? value
      : await scalar(conn, `SELECT ${expr} AS v FROM ${sub(layer.sql, base)}`);
  return { id: widget.id, type: "formula", value, baseline };
}

async function categoryValue(
  conn: Conn,
  widget: MapWidget & { type: "category" },
  layer: Layer,
  constrained: LayerFilter[],
): Promise<WidgetValue> {
  const col = ident(widget.field!);
  const rank = aggExpr(widget.agg, widget.aggField);
  const from = sub(layer.sql, [...layer.filters, ...constrained]);
  // NULL categories are dropped, matching aggregate semantics.
  const reader = await conn.runAndReadAll(
    `SELECT CAST(${col} AS VARCHAR) AS v, ${rank} AS n FROM ${from}
     WHERE ${col} IS NOT NULL
     GROUP BY 1 ORDER BY n DESC NULLS LAST, v LIMIT ${CATEGORY_TOP_N + 1}`,
  );
  const rows = reader
    .getRowObjects()
    .map((r) => ({ value: String(r.v), n: Number(r.n) }))
    .filter((r) => Number.isFinite(r.n));
  const categories = rows.slice(0, CATEGORY_TOP_N);
  let other: number | null = null;
  if (rows.length > CATEGORY_TOP_N) {
    const list = categories
      .map((c) => `'${c.value.replace(/'/g, "''")}'`)
      .join(", ");
    other = await scalar(
      conn,
      `SELECT ${rank} AS v FROM ${from}
       WHERE ${col} IS NOT NULL AND CAST(${col} AS VARCHAR) NOT IN (${list})`,
    );
  }
  return { id: widget.id, type: "category", categories, other };
}

async function histogramValue(
  conn: Conn,
  widget: MapWidget & { type: "histogram" },
  layer: Layer,
  constrained: LayerFilter[],
): Promise<WidgetValue> {
  const expr = `${ident(widget.field!)}::DOUBLE`;
  // Domain from the selection-free query, so the axis holds still while
  // other widgets cross-filter and bars shrink in place.
  const domainReader = await conn.runAndReadAll(
    `SELECT min(${expr}) AS lo, max(${expr}) AS hi
     FROM ${sub(layer.sql, layer.filters)} WHERE ${expr} IS NOT NULL`,
  );
  const d = domainReader.getRowObjects()[0] as { lo: unknown; hi: unknown };
  const lo = Number(d?.lo);
  const hi = Number(d?.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
    return { id: widget.id, type: "histogram", domain: null, bins: [] };
  }
  const step = (hi - lo) / WIDGET_HISTOGRAM_BINS;
  const reader = await conn.runAndReadAll(
    `SELECT least(floor((${expr} - (${lo})) / (${step})), ${WIDGET_HISTOGRAM_BINS - 1})::INT AS b,
            count(*) AS n
     FROM ${sub(layer.sql, [...layer.filters, ...constrained])}
     WHERE ${expr} IS NOT NULL GROUP BY b`,
  );
  const bins = new Array<number>(WIDGET_HISTOGRAM_BINS).fill(0);
  for (const row of reader.getRowObjects() as { b: unknown; n: unknown }[]) {
    const i = Number(row.b);
    if (Number.isInteger(i) && i >= 0 && i < WIDGET_HISTOGRAM_BINS) {
      bins[i] = Number(row.n);
    }
  }
  return {
    id: widget.id,
    type: "histogram",
    domain: { min: lo, max: hi },
    bins,
  };
}

/**
 * The visualization types whose cross-filtering settles through a server
 * re-render: their result is computed — cells, clusters, heat — so the
 * client has nothing it could re-filter. None of them ever tile, so an
 * ephemeral render can never trigger a tile build. Every other type
 * enforces selections on the GPU.
 */
const SETTLE_VIZ = new Set(["hexbin", "grid", "cluster", "heatmap"]);

/**
 * Render a layer with an ephemeral selection set folded into its SQL — the
 * settle lane. A read: nothing is written, and the canonical render returns
 * when selections clear. The filters arrive pre-resolved (the shared
 * selection→filter translation) and compile through the same escaping as
 * stored filters.
 */
export async function renderLayerWithSelections(
  layer: Layer,
  filters: LayerFilter[],
  signal?: AbortSignal,
  opts: RenderLayerOpts = {},
): Promise<LayerRenderData> {
  if (!SETTLE_VIZ.has(layer.viz.type)) {
    throw new ApiError(
      "invalid_request",
      "Ephemeral selections apply to hexbin, grid, cluster, and heatmap " +
        "layers; other types enforce selections client-side.",
      400,
    );
  }
  if (opts.published && filters.length > 0) {
    // Reader input is bounded by the published surface: a selection may
    // only reference what that surface declares — the effective
    // published field set, or the field of a published widget bound to
    // this layer (computed layers cross-filter on base columns their
    // cells no longer carry). Anything else is refused before any
    // evaluation touches it. Computed layers accept only widget fields:
    // selections fold into the BASE query, where the cells' output names
    // (`value`, `count`) do not exist — accepting them would evaluate
    // reader input against undeclared base columns, or error raw (review
    // round two). Only the wire-carrying viz types need the column read
    // at all.
    const declared = new Set<string>();
    // Selections fold into the BASE query on every settle type, so the
    // base schema is read for all of them — it carries the kinds the
    // compatibility rule below needs, and for wire-carrying types the
    // names the published projection intersects.
    let resolved: { name: string; kind: string }[];
    try {
      resolved = await baseFields(layer, signal);
    } catch (error) {
      // The check reads the result's columns, so it evaluates under the
      // same bounds as the render — and the settle lane's contract is
      // the errored envelope, never a thrown evaluation failure.
      if (error instanceof EvaluationCancelled) throw error;
      return {
        layerId: layer.id,
        ok: false,
        error: {
          code: error instanceof ApiError ? error.code : "sql_error",
          message:
            error instanceof Error
              ? error.message
              : "The layer could not render.",
        },
      };
    }
    if (!isAggregated(layer.viz)) {
      const columns = resolved.map((f) => f.name);
      for (const f of publishedFieldsFor(layer, opts.published, columns)) {
        declared.add(f);
      }
    }
    if (opts.published.widgetsPublished) {
      for (const w of opts.published.widgets) {
        if (w.visible && w.layerId === layer.id && w.field) {
          declared.add(w.field);
        }
      }
    }
    const foreign = filters.find((f) => !declared.has(f.field));
    if (foreign) {
      throw new ApiError(
        "field_not_published",
        `The field "${foreign.field}" is not part of this map's published fields.`,
        400,
      );
    }
    // Kind compatibility: a declared field's selection must be
    // evaluable against the column's kind, or the fold would hand
    // reader input to the engine and ship its raw error back. Ranges
    // span numbers, time ranges span time, value sets apply anywhere; a
    // declared field the result no longer provides refuses the same
    // way, before any evaluation.
    const kinds = new Map(resolved.map((f) => [f.name, f.kind]));
    for (const f of filters) {
      const kind = kinds.get(f.field);
      if (kind === undefined) {
        throw new ApiError(
          "selection_incompatible",
          `The selection references "${f.field}", which the layer's result no longer provides.`,
          400,
        );
      }
      const needs =
        f.kind === "range" ? "numeric" : f.kind === "timerange" ? "time" : null;
      if (needs !== null && kind !== needs) {
        throw new ApiError(
          "selection_incompatible",
          `The selection on "${f.field}" needs a ${needs} column; it is ${kind}.`,
          400,
        );
      }
    }
  }
  if (filters.length === 0) return renderLayer(layer, signal, opts);
  return renderLayer(
    { ...layer, sql: filteredSql(layer.sql, filters) },
    signal,
    opts,
  );
}

/**
 * The published widget-values lane's reader gate (induction half on
 * this route): each selection resolves against its stored widget
 * through the shared translation, and the folded filter must be
 * evaluable against the bound layer's base schema — a range selection
 * needs the numeric column its histogram claims, and a column the
 * result no longer provides refuses rather than reaching the engine. A
 * layer whose schema cannot be resolved skips the gate: its widgets
 * degrade per-widget exactly as today, and reader input adds nothing to
 * that failure. The builder lane stays author-facing and ungated.
 */
export async function assertPublishedSelections(
  map: MapRecord,
  layers: Layer[],
  selections: WidgetSelection[],
  signal?: AbortSignal,
): Promise<void> {
  if (selections.length === 0) return;
  const widgets = new Map(map.widgets.map((w) => [w.id, w]));
  const layerById = new Map(layers.map((l) => [l.id, l]));
  const perLayer = new Map<string, LayerFilter[]>();
  for (const s of selections) {
    const widget = widgets.get(s.widgetId);
    const filter = selectionFilter(s, widget);
    if (!filter || !widget?.layerId || !layerById.has(widget.layerId)) {
      continue; // unresolvable selections filter nothing, as ever
    }
    perLayer.set(widget.layerId, [
      ...(perLayer.get(widget.layerId) ?? []),
      filter,
    ]);
  }
  for (const [layerId, filters] of perLayer) {
    const layer = layerById.get(layerId)!;
    let fields: { name: string; kind: string }[];
    try {
      fields = await baseFields(layer, signal);
    } catch (error) {
      // Bounded outcomes are the request's outcome — a timeout or
      // memory refusal here must surface, not roll into a second full
      // evaluation downstream. Only a genuine schema
      // failure skips the gate into per-widget degradation.
      if (error instanceof EvaluationCancelled || error instanceof ApiError) {
        throw error;
      }
      continue;
    }
    const kinds = new Map(fields.map((f) => [f.name, f.kind]));
    for (const f of filters) {
      const kind = kinds.get(f.field);
      if (kind === undefined) {
        throw new ApiError(
          "selection_incompatible",
          `The selection references "${f.field}", which the layer's result no longer provides.`,
          400,
        );
      }
      if (f.kind === "range" && kind !== "numeric") {
        throw new ApiError(
          "selection_incompatible",
          `The selection on "${f.field}" needs a numeric column; it is ${kind}.`,
          400,
        );
      }
    }
  }
}

/**
 * Compute every visible widget's value plus per-layer constrained/total row
 * counts (the status line's truth). A widget whose layer is gone or whose
 * query fails yields a per-widget error — the dashboard keeps working. An
 * optional draft widget rides the request: the builder's open editor
 * previews live — computed exactly like a stored widget, replacing its
 * stored self by id or joining as a new card, and never written.
 */
export async function computeWidgetValues(
  map: MapRecord,
  layers: Layer[],
  selections: WidgetSelection[],
  draft?: MapWidget,
  signal?: AbortSignal,
): Promise<WidgetValues> {
  const effective = draft
    ? map.widgets.some((w) => w.id === draft.id)
      ? map.widgets.map((w) => (w.id === draft.id ? draft : w))
      : [...map.widgets, draft]
    : map.widgets;
  // Notes are authored text — nothing to compute.
  const widgets = effective.filter(isDataWidget).filter((w) => w.visible);
  const layerById = new Map(layers.map((l) => [l.id, l]));
  return boundedEvaluation(async (conn, bounds) => {
    const values: WidgetValue[] = [];
    for (const widget of widgets) {
      const layer = layerById.get(widget.layerId);
      if (!layer) {
        values.push({
          id: widget.id,
          error: "The widget's layer is gone.",
          errorCode: "widget_layer_missing",
        });
        continue;
      }
      const constrained = selectionFilters(
        selections,
        effective,
        layer.id,
        widget.id,
      );
      try {
        if (widget.type === "formula") {
          values.push(await formulaValue(conn, widget as MapWidget & { type: "formula" }, layer, constrained));
        } else if (widget.type === "category") {
          values.push(await categoryValue(conn, widget as MapWidget & { type: "category" }, layer, constrained));
        } else {
          values.push(await histogramValue(conn, widget as MapWidget & { type: "histogram" }, layer, constrained));
        }
      } catch (error) {
        // The bound's outcomes are the whole request's, not one widget's —
        // swallowing them here would ship a successful response of
        // per-widget engine noise. The boundary's own flag decides, never
        // the message text, which user data can forge.
        if (bounds.interrupted() || isOutOfMemory(error)) throw error;
        values.push({
          id: widget.id,
          error:
            error instanceof Error ? error.message : "The widget query failed.",
          errorCode: error instanceof ApiError ? error.code : "sql_error",
        });
      }
    }

    const counts: WidgetLayerCount[] = [];
    for (const layerId of new Set(widgets.map((w) => w.layerId))) {
      const layer = layerById.get(layerId);
      if (!layer) continue;
      const all = selectionFilters(selections, effective, layerId, null);
      try {
        const count = await scalar(
          conn,
          `SELECT count(*) AS v FROM ${sub(layer.sql, [...layer.filters, ...all])}`,
        );
        const total =
          all.length === 0
            ? count
            : await scalar(
                conn,
                `SELECT count(*) AS v FROM ${sub(layer.sql, layer.filters)}`,
              );
        counts.push({ layerId, count: count ?? 0, total: total ?? 0 });
      } catch (error) {
        if (bounds.interrupted() || isOutOfMemory(error)) throw error;
        // A broken layer already surfaces through its widgets.
      }
    }
    return { widgets: values, layers: counts };
  }, { signal });
}

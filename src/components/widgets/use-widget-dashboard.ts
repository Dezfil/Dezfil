"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayerRenderData } from "@/lib/layer-service";
import type { WidgetValues } from "@/lib/widget-service";
import type { LayerFilter } from "@/lib/viz";
import {
  selectionDim,
  liveDim,
  LIVE_FILTER_SLOTS,
  type LiveDim,
} from "@/lib/live-filters";
import {
  selectionFilter,
  selectionFilters,
  type MapWidget,
  type WidgetSelection,
} from "@/lib/widgets";
import {
  ANSWER_CURRENT,
  beginAnswer,
  resolveAnswer,
  settleVerdict,
  type AnswerState,
  type EndpointResult,
} from "./dashboard-state";
import { budgetSelections, DROPPED_HINT } from "./selection-budget";

/**
 * The dashboard's client half, shared by the builder and the published
 * viewer: selection state, batched value fetches, and the fan-out of
 * selections to the two enforcement lanes — GPU dimensions for layers that
 * draw real features, and settle re-renders for computed results
 * (hexbin/grid cells, an undelegated heatmap). Selections are session
 * state: nothing here writes, and a reload opens clean.
 */

/** What the hook needs to know about one layer to route enforcement. */
export interface DashboardLayer {
  id: string;
  vizType: string;
  /** Heatmap only: whether the render shipped undelegated (settle lane). */
  liveFiltered: boolean;
  /** GPU dimensions the layer's stored filters already occupy. */
  storedDims: number;
}

export interface DashboardEndpoints {
  values: (
    selections: WidgetSelection[],
  ) => Promise<EndpointResult<WidgetValues>>;
  settle: (
    layerId: string,
    filters: LayerFilter[],
  ) => Promise<EndpointResult<LayerRenderData>>;
}

/** Layers whose selections settle server-side: their drawn result is
 * computed, so the client has nothing it could re-filter. Cluster is NOT
 * here — it re-clusters from dims client-side (JS filter). */
function settles(l: DashboardLayer): boolean {
  if (l.vizType === "hexbin" || l.vizType === "grid") return true;
  return l.vizType === "heatmap" && !l.liveFiltered;
}

export interface WidgetDashboard {
  selections: WidgetSelection[];
  values: WidgetValues | null;
  /** Truth state of the values the cards and readouts show. */
  valuesState: AnswerState;
  /** Merged per-layer GPU dims: selection dims for the canvas. */
  selectionDims: Record<string, LiveDim[]>;
  /** Per-layer settle re-renders, present while selections constrain them. */
  settleRenders: Record<string, LayerRenderData>;
  /** Truth state per settle-lane layer, present only while selections
   * constrain it: updating, current, or failed — a failed settle means the
   * canonical render shows with the selection unapplied. */
  settleStates: Record<string, AnswerState>;
  /** A short notice when a selection was refused (the GPU budget). */
  hint: string | null;
  toggleCategory: (widgetId: string, value: string) => void;
  brushRange: (widgetId: string, min: number | null, max: number | null) => void;
  clearSelection: (widgetId: string) => void;
  clearAll: () => void;
  /** Re-run a failed values fetch under the same conditions. */
  retryValues: () => void;
  /** Re-run a failed settle for one layer under the same conditions. */
  retrySettle: (layerId: string) => void;
}

export function useWidgetDashboard({
  widgets,
  layers,
  endpoints,
  revision,
}: {
  /** The map's visible, resolvable widgets, in rail order. */
  widgets: MapWidget[];
  layers: DashboardLayer[];
  endpoints: DashboardEndpoints;
  /** Bump to refetch values (an edit settled, a layer changed). */
  revision: number | string;
}): WidgetDashboard {
  const [rawSelections, setSelections] = useState<WidgetSelection[]>([]);
  const [values, setValues] = useState<WidgetValues | null>(null);
  // Truth states, written only when a fetch resolves and keyed by the
  // conditions it answered — the loading/updating half is DERIVED from the
  // key mismatch, so conditions changes never write state.
  const [valuesResolved, setValuesResolved] = useState<{
    key: string;
    state: AnswerState;
  } | null>(null);
  const [settleResolved, setSettleResolved] = useState<
    Record<string, { key: string; state: AnswerState }>
  >({});
  const [valuesRetry, setValuesRetry] = useState(0);
  const [settleRetries, setSettleRetries] = useState<Record<string, number>>(
    {},
  );
  // Fetched settle re-renders, keyed by the filters they answer — exposure
  // is derived, so clearing a selection needs no state write.
  const [settleCache, setSettleCache] = useState<
    Record<string, { key: string; render: LayerRenderData }>
  >({});
  const [hint, setHint] = useState<string | null>(null);
  const layerById = useMemo(
    () => new Map(layers.map((l) => [l.id, l])),
    [layers],
  );
  const widgetById = useMemo(
    () => new Map(widgets.map((w) => [w.id, w])),
    [widgets],
  );

  // Selections whose widget disappeared (deleted, hidden, layer gone) fall
  // away by derivation — never a state write. So does a selection the
  // enforcement budget cannot hold: stored filters and the timeline take
  // precedence, and the displaced selection leaves every surface — never
  // shown active while unapplied.
  const { selections, droppedLayers } = useMemo(
    () =>
      budgetSelections(
        rawSelections,
        widgets,
        layers.map((l) => ({
          id: l.id,
          settles: settles(l),
          storedDims: l.storedDims,
        })),
        LIVE_FILTER_SLOTS,
      ),
    [rawSelections, widgets, layers],
  );
  // The displacement is a DROP, not a park: the raw
  // list is pruned to what the budget holds, so a later freed slot can
  // never silently re-apply a filter the user last saw removed. The
  // notice persists until the next selection action, so the drop is
  // never silent either.
  //
  // Written during render — React's documented adjustment for state that
  // must follow a prop change, and it converges in one pass: a non-empty
  // drop list means the budgeted list is strictly shorter, so the very
  // next render has nothing left to drop.
  if (droppedLayers.length > 0) {
    setHint(DROPPED_HINT);
    setSelections(selections);
  }

  /** GPU dims a layer would carry under a prospective selection set. */
  const dimsFor = useCallback(
    (layerId: string, sels: WidgetSelection[]): LiveDim[] => {
      const out: LiveDim[] = [];
      for (const s of sels) {
        const w = widgetById.get(s.widgetId);
        if (!w || w.layerId !== layerId || w.field === null) continue;
        if (s.kind === "exclude") {
          out.push(selectionDim(w.field, s.values));
        } else {
          out.push(liveDim({ field: w.field, kind: "range", min: s.min, max: s.max }));
        }
      }
      return out;
    },
    [widgetById],
  );

  /** Refuse a selection the GPU budget cannot hold (spec blocked
   * with a hint, never silent under-filtering). Settle layers have no
   * budget — their selections go to SQL. */
  const withinBudget = useCallback(
    (widgetId: string, next: WidgetSelection[]): boolean => {
      const widget = widgetById.get(widgetId);
      const layer =
        widget && widget.layerId ? layerById.get(widget.layerId) : undefined;
      if (!widget || !layer || settles(layer)) return true;
      const used = layer.storedDims + dimsFor(layer.id, next).length;
      if (used <= LIVE_FILTER_SLOTS) return true;
      setHint(
        "This layer already carries the maximum live constraints. Remove " +
          "a selection or a live filter first.",
      );
      return false;
    },
    [widgetById, layerById, dimsFor],
  );

  const apply = useCallback(
    (widgetId: string, next: WidgetSelection[]) => {
      if (!withinBudget(widgetId, next)) return;
      setHint(null);
      setSelections(next);
    },
    [withinBudget],
  );

  // Category clicks toggle EXCLUSION: all categories are active by
  // default; each click knocks one out or lets it back in. An empty
  // exclusion set means no selection at all.
  const toggleCategory = useCallback(
    (widgetId: string, value: string) => {
      const current = selections.find((s) => s.widgetId === widgetId);
      const excluded =
        current?.kind === "exclude"
          ? current.values.includes(value)
            ? current.values.filter((v) => v !== value)
            : [...current.values, value]
          : [value];
      const rest = selections.filter((s) => s.widgetId !== widgetId);
      apply(
        widgetId,
        excluded.length
          ? [...rest, { widgetId, kind: "exclude", values: excluded }]
          : rest,
      );
    },
    [selections, apply],
  );

  const brushRange = useCallback(
    (widgetId: string, min: number | null, max: number | null) => {
      const rest = selections.filter((s) => s.widgetId !== widgetId);
      const cleared = min === null && max === null;
      apply(
        widgetId,
        cleared ? rest : [...rest, { widgetId, kind: "range", min, max }],
      );
    },
    [selections, apply],
  );

  const clearSelection = useCallback(
    (widgetId: string) => {
      setHint(null);
      setSelections((prev) => prev.filter((s) => s.widgetId !== widgetId));
    },
    [],
  );

  const clearAll = useCallback(() => {
    setHint(null);
    setSelections([]);
  }, []);

  // values: one batched, debounced fetch ---- Notes are authored text —
  // nothing to compute. A rail of notes alone asks the server nothing,
  // so it can never report a failed answer that does not exist (review
  // round two).
  const computes = widgets.some((w) => w.layerId !== null);
  const selectionsKey = JSON.stringify(selections);
  // Only what the server computes from re-keys the batched read:
  // presentation text — title, note, unit, format — and card order cannot
  // change the numbers, so a keystroke in them must not recompute every
  // widget value. The projection is sorted by id so the key is canonical
  // under reorder.
  const widgetsKey = JSON.stringify(
    widgets
      .map((w) => [w.id, w.type, w.layerId, w.field, w.agg, w.aggField, w.visible])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  // The conditions one values answer belongs to; a retry is a new key so
  // it re-runs the same fetch without pretending conditions changed.
  const valuesKey = JSON.stringify([
    selectionsKey,
    widgetsKey,
    revision,
    valuesRetry,
  ]);
  const fetchSeq = useRef(0);
  useEffect(() => {
    if (!computes) return;
    const seq = ++fetchSeq.current;
    const timer = setTimeout(() => {
      void endpoints.values(selections).then((outcome) => {
        // Superseded — newer conditions own the state (not a failure);
        // this answer is simply dropped.
        if (fetchSeq.current !== seq) return;
        setValuesResolved({
          key: valuesKey,
          state: resolveAnswer(beginAnswer(true), false, outcome),
        });
        if (outcome.ok) setValues(outcome.data);
      });
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesKey]);

  // The recomputation window opens with the condition change, debounce
  // included: prior numbers are stale from that moment, not from the
  // request leaving. Derived, never a state write.
  const valuesState: AnswerState = useMemo(() => {
    if (!computes) return ANSWER_CURRENT;
    if (valuesResolved && valuesResolved.key === valuesKey) {
      return valuesResolved.state;
    }
    return beginAnswer(values !== null);
  }, [computes, valuesResolved, valuesKey, values]);

  // ---- GPU lane: per-layer selection dims ----
  const selectionDims = useMemo(() => {
    const out: Record<string, LiveDim[]> = {};
    for (const l of layers) {
      if (settles(l)) continue;
      const dims = dimsFor(l.id, selections);
      if (dims.length) out[l.id] = dims;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, selectionsKey, dimsFor]);

  // ---- settle lane: computed layers re-render server-side ----
  // Two keys per layer: the filters key names the answer (the cache and
  // its exposure), the state key adds the retry generation so a retry
  // re-runs the same fetch and reads as updating while it does.
  const settleWanted = useRef<Record<string, string>>({});
  const settleLayersKey = layers.map((l) => `${l.id}:${settles(l)}`).join(",");
  const settleRetriesKey = JSON.stringify(settleRetries);
  useEffect(() => {
    for (const l of layers) {
      if (!settles(l)) continue;
      const layerId = l.id;
      const filters = selectionFilters(selections, widgets, layerId, null);
      const filtersKey = JSON.stringify(filters);
      const stateKey = `${settleRetries[layerId] ?? 0}|${filtersKey}`;
      settleWanted.current[layerId] = stateKey;
      if (filters.length === 0) continue; // exposure derives to the canonical render
      void endpoints.settle(layerId, filters).then((result) => {
        // Superseded — newer conditions own the state; not a failure.
        if (settleWanted.current[layerId] !== stateKey) return;
        const { render, failure } = settleVerdict(result);
        if (render) {
          setSettleCache((prev) => ({
            ...prev,
            [layerId]: { key: filtersKey, render },
          }));
          setSettleResolved((prev) => ({
            ...prev,
            [layerId]: { key: stateKey, state: ANSWER_CURRENT },
          }));
        } else {
          // The selection is not applied: drop any settled frame so the
          // canonical render shows, and keep the coded reason for the
          // failed surface.
          setSettleCache((prev) => {
            if (!(layerId in prev)) return prev;
            const rest = { ...prev };
            delete rest[layerId];
            return rest;
          });
          setSettleResolved((prev) => ({
            ...prev,
            [layerId]: { key: stateKey, state: { status: "failed", error: failure } },
          }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionsKey, widgetsKey, settleLayersKey, settleRetriesKey]);

  // Truth state per constrained settle layer, derived: a resolved
  // answer for the current key wins; otherwise the lane is loading — or
  // updating when a still-valid settled frame is showing.
  const settleStates = useMemo(() => {
    const out: Record<string, AnswerState> = {};
    for (const l of layers) {
      if (!settles(l)) continue;
      const filters = selectionFilters(selections, widgets, l.id, null);
      if (filters.length === 0) continue; // canonical is the current answer
      const filtersKey = JSON.stringify(filters);
      const stateKey = `${settleRetries[l.id] ?? 0}|${filtersKey}`;
      const resolved = settleResolved[l.id];
      if (resolved && resolved.key === stateKey) {
        out[l.id] = resolved.state;
      } else {
        const cached = settleCache[l.id];
        out[l.id] = beginAnswer(!!cached && cached.key === filtersKey);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    layers,
    selectionsKey,
    widgetsKey,
    settleResolved,
    settleCache,
    settleRetriesKey,
  ]);

  // Exposure: only renders that answer the CURRENT selections; anything
  // else (cleared, superseded, still in flight) falls back to canonical.
  const settleRenders = useMemo(() => {
    const out: Record<string, LayerRenderData> = {};
    for (const l of layers) {
      if (!settles(l)) continue;
      const filters = selectionFilters(selections, widgets, l.id, null);
      if (filters.length === 0) continue;
      const cached = settleCache[l.id];
      if (cached && cached.key === JSON.stringify(filters)) {
        out[l.id] = cached.render;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleCache, selectionsKey, widgetsKey, layers]);

  const retryValues = useCallback(() => setValuesRetry((n) => n + 1), []);
  const retrySettle = useCallback(
    (layerId: string) =>
      setSettleRetries((prev) => ({
        ...prev,
        [layerId]: (prev[layerId] ?? 0) + 1,
      })),
    [],
  );

  return {
    selections,
    values: computes ? values : null,
    valuesState,
    selectionDims,
    settleRenders,
    settleStates,
    hint,
    toggleCategory,
    brushRange,
    clearSelection,
    clearAll,
    retryValues,
    retrySettle,
  };
}

/** The filter a widget's own selection means — for chips and card state. */
export function ownSelectionFilter(
  selections: WidgetSelection[],
  widget: MapWidget,
): LayerFilter | null {
  const s = selections.find((x) => x.widgetId === widget.id);
  return s ? selectionFilter(s, widget) : null;
}

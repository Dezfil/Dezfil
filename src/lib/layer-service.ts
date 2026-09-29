import type { DatasetScope } from "@/lib/query/access";
import type { AccountScope } from "@/lib/auth/scope";
import { requireLayer } from "./layer-access";
import { assertWritableRefs } from "./layer-write-refs";
export { requireLayer } from "./layer-access";
export { createLayer, duplicateLayer } from "./layer-creation";
export { layerImage } from "./layer-history-image";
export { fieldKind, layerFields, fieldsForWrite, baseFields, layerFieldStats, DISTRIBUTION_BINS,
  type FieldKind, type LayerField, type LayerFieldsResult, type FieldStats } from "./layer-fields";
import { ApiError } from "@/lib/api/errors";
import {
  isBoundedOutcome,
} from "@/lib/query/bounded";
import {
  effectiveSql,
} from "@/lib/query/compile";
import { inspectLayerGeometry } from "@/lib/layer-geometry";
import {
  updateLayerFields,
  type Layer,
} from "@/lib/metadata/maps";
import { metadataDb } from "@/lib/metadata/db";
import {
  recordStep,
  diffImages,
  stableJson,
} from "@/lib/metadata/history";
import {
  styleProblem,
  normalizeStyle,
  type FillPaint,
  type LayerStyle,
} from "@/lib/style/style";
import { classifyFill, computeSizeScale } from "@/lib/style/classify";
import {
  AGG_VALUE,
  AGG_ELEV,
  isAggregated,
  isOdViz,
  effectiveStyle,
  type LayerFilter,
  type LayerViz,
  type AggregatedViz,
  type CellElevation,
  type LegendAttrs,
  type LegendChannelKey,
} from "@/lib/viz";
import {
  filterRefs,
  listRefs,
  styleRefs,
  vizRefs,
  type ColumnRef,
} from "@/lib/column-validation";
import { legendFor, legendSlotCount } from "@/lib/style/legend";
export { renderLayer, type LayerRenderData, type LayerTiles, type LayerRenderGeometryType, type RenderLayerOpts } from "./layer-render";
export { liveRenderFilters, renderFilters } from "./layer-render-filters";

/**
 * The attribute-name overrides that survive a style/viz change: a channel
 * keeps its override only while it still shows and is driven by the same
 * attribute. Returns the pruned record (null when nothing survives), or
 * undefined when nothing needs pruning.
 */
function staleLegendAttrs(
  attrs: LegendAttrs,
  before: LayerStyle,
  after: LayerStyle,
): LegendAttrs | null | undefined {
  const channelAttribute = (style: LayerStyle): Map<string, string> => {
    const legend = legendFor(style);
    const m = new Map<string, string>();
    for (const p of legend?.paints ?? []) m.set(p.channel, p.attribute);
    for (const s of legend?.sizes ?? []) m.set(s.channel, s.attribute);
    return m;
  };
  const was = channelAttribute(before);
  const now = channelAttribute(after);
  const kept: LegendAttrs = {};
  let pruned = false;
  for (const [channel, name] of Object.entries(attrs)) {
    const attribute = now.get(channel);
    if (attribute !== undefined && attribute === was.get(channel)) {
      kept[channel as LegendChannelKey] = name;
    } else {
      pruned = true;
    }
  }
  if (!pruned) return undefined;
  return Object.keys(kept).length ? kept : null;
}

type UpdateLayerFields = Partial<{
  name: string;
  sql: string;
  style: LayerStyle;
  visible: boolean;
  tooltip: string[] | null;
  popup: string[] | null;
  publishedFields: string[] | null;
  inLegend: boolean;
  viz: LayerViz;
  filters: LayerFilter[];
  legendTitle: string | null;
  legendLabels: (string | null)[] | null;
  legendAttrs: LegendAttrs | null;
}>;

export async function updateLayer(
  scope: AccountScope,
  id: string,
  fields: UpdateLayerFields,
  opts: { groupId?: string | null; signal?: AbortSignal } = {},
): Promise<Layer> {
  // The coupled adjustments below derive whole style/viz containers from a
  // snapshot while engine work yields; a concurrent write landing in that
  // window would be silently overwritten at commit. Re-derive against a
  // fresh snapshot until the commit's read matches the one the derivation
  // used — no accepted write is lost.
  for (let attempt = 0; attempt < 5; attempt++) {
    const applied = await deriveAndCommitUpdate(scope, id, fields, opts);
    if (applied) return applied;
  }
  // Practically unreachable: it needs a concurrent write landing inside
  // every derivation window, five times running. Refusing truthfully beats
  // committing stale derivations — and stays inside the documented error
  // catalog rather than minting a new code for a pathological path.
  throw new ApiError(
    "internal",
    "The layer kept changing while this save was settling; it was not applied.",
    500,
  );
}

async function deriveAndCommitUpdate(
  scope: AccountScope,
  id: string,
  fields: UpdateLayerFields,
  opts: { groupId?: string | null; signal?: AbortSignal },
): Promise<Layer | null> {
  const layer = requireLayer(scope, id);
  // A repeated write of the same filter image is a true no-op: in
  // particular, it must not turn into a classification-only history step.
  // stableJson makes this insensitive to object key order at the API edge.
  const filtersChanged =
    fields.filters !== undefined &&
    stableJson(fields.filters) !== stableJson(layer.filters);
  if (fields.sql !== undefined && fields.sql !== layer.sql) {
    // Editing SQL revalidates geometry, but the layer is not recreated.
    await inspectLayerGeometry(scope, fields.sql, opts.signal);
  }
  if (fields.style !== undefined) {
    const problem = styleProblem(fields.style);
    if (problem) {
      throw new ApiError("invalid_request", `The style is not valid: ${problem}`, 400);
    }
    fields = { ...fields, style: normalizeStyle(fields.style) };
  }

  // Semantic validation: references this request introduces or changes
  // must resolve against the schema as the request leaves it. Stored
  // references echoed unchanged pass, and a SQL edit is never refused
  // for the references it strands — read-time degradation keeps covering
  // those. Runs before the derivations below so a bogus reference
  // refuses with the documented code instead of surfacing as an engine
  // error from derivation work.
  {
    const nextViz = fields.viz ?? layer.viz;
    const incoming: ColumnRef[] = [];
    const stored: ColumnRef[] = [];
    if (fields.style !== undefined) {
      incoming.push(...styleRefs(fields.style));
      stored.push(...styleRefs(layer.style));
    }
    if (fields.viz !== undefined) {
      incoming.push(...vizRefs(fields.viz));
      stored.push(...vizRefs(layer.viz));
    }
    if (fields.filters !== undefined) {
      incoming.push(...filterRefs(fields.filters));
      stored.push(...filterRefs(layer.filters));
    }
    if (fields.tooltip !== undefined) {
      incoming.push(...listRefs(fields.tooltip, "styling", "tooltip"));
      stored.push(...listRefs(layer.tooltip, "styling", "tooltip"));
    }
    if (fields.popup !== undefined) {
      incoming.push(...listRefs(fields.popup, "styling", "pop-up"));
      stored.push(...listRefs(layer.popup, "styling", "pop-up"));
    }
    if (fields.publishedFields !== undefined) {
      incoming.push(
        ...listRefs(fields.publishedFields, "filterable", "published fields"),
      );
      stored.push(
        ...listRefs(layer.publishedFields, "filterable", "published fields"),
      );
    }
    // On an aggregated layer the label's attribute is dropped by the
    // normalization below, not stored — a reference that will not
    // survive the write is not validated.
    const validating = isAggregated(nextViz)
      ? incoming.filter((ref) => ref.channel !== "label")
      : incoming;
    await assertWritableRefs(scope,
      validating,
      stored,
      fields.sql ?? layer.sql,
      nextViz,
      opts.signal,
    );
  }
  if (
    fields.viz !== undefined &&
    fields.viz.type !== "points" &&
    !isOdViz(fields.viz)
  ) {
    // Hexbin, grid, and heatmap draw point results; line and polygon layers
    // keep simple rendering. Arc/line ignore the primary geometry entirely
    // — their endpoints are mapped.
    const inspection = await inspectLayerGeometry(scope,
      fields.sql ?? layer.sql,
      opts.signal,
    );
    if (inspection.geometryType && !/POINT|MIXED/.test(inspection.geometryType)) {
      throw new ApiError(
        "invalid_request",
        `The "${fields.viz.type}" visualization needs point geometries; this layer has ${inspection.geometryType.toLowerCase()}s.`,
        400,
      );
    }
    if (isAggregated(fields.viz)) {
      const viz = { ...fields.viz };
      if (filtersChanged) {
        // Filters reshape the aggregate distribution just as surely as an
        // aggregation edit. Settle the authoritative stored fill over the
        // complete next filter set; previews deliberately keep the old fill
        // only until this mutation is accepted.
        viz.fill = await filterSettledAggregatedFill(scope,
          {
            sql: fields.sql ?? layer.sql,
            filters: fields.filters ?? layer.filters,
            viz,
          },
          inspection.geometryColumn,
          viz.fill ?? priorAggregatedFill(layer),
          fields.style ?? layer.style,
          opts.signal,
        );
      } else if (viz.fill === undefined) {
        // The aggregation changed, so its value distribution did too: assign
        // a fill over the aggregate value, keeping any prior ramp choices
        // (classification applies to the aggregate value).
        viz.fill = await aggregatedFill(scope,
          {
            sql: fields.sql ?? layer.sql,
            filters: fields.filters ?? layer.filters,
            viz,
          },
          inspection.geometryColumn,
          priorAggregatedFill(layer),
          fields.style ?? layer.style,
          opts.signal,
        );
      }
      // The extrusion's domain follows the same truthfulness rule as the
      // fill: any query-shaping change re-resolves it; a pure height
      // change reuses the prior domain instead of re-aggregating.
      if (viz.elevation) {
        const prior = isAggregated(layer.viz)
          ? layer.viz.elevation
          : undefined;
        const unchangedQuery =
          !filtersChanged &&
          fields.sql === undefined &&
          prior?.domain !== undefined &&
          isAggregated(layer.viz) &&
          layer.viz.cellKm === viz.cellKm &&
          layer.viz.type === viz.type &&
          JSON.stringify(prior.aggregate) ===
            JSON.stringify(viz.elevation.aggregate);
        viz.elevation = unchangedQuery
          ? { ...viz.elevation, domain: prior!.domain }
          : await settledElevation(scope,
              {
                sql: fields.sql ?? layer.sql,
                filters: fields.filters ?? layer.filters,
                viz,
              },
              inspection.geometryColumn,
              opts.signal,
            );
      }
      fields = { ...fields, viz };
    }
  }

  // A filters-only update still changes the values behind a hex/grid fill.
  // Fold the newly classified viz into the same write so history can never
  // expose a filters/classification mismatch. effectiveSql inside the helper
  // receives every durable filter, including ones delegated live at render
  // time.
  if (
    filtersChanged &&
    fields.viz === undefined &&
    isAggregated(layer.viz)
  ) {
    const inspection = await inspectLayerGeometry(scope,
      fields.sql ?? layer.sql,
      opts.signal,
    );
    const viz = { ...layer.viz };
    viz.fill = await filterSettledAggregatedFill(scope,
      {
        sql: fields.sql ?? layer.sql,
        filters: fields.filters ?? layer.filters,
        viz,
      },
      inspection.geometryColumn,
      viz.fill,
      fields.style ?? layer.style,
      opts.signal,
    );
    if (viz.elevation) {
      viz.elevation = await settledElevation(scope,
        {
          sql: fields.sql ?? layer.sql,
          filters: fields.filters ?? layer.filters,
          viz,
        },
        inspection.geometryColumn,
        opts.signal,
      );
    }
    fields = { ...fields, viz };
  }

  // A label's source must match the visualization: aggregated cells label
  // themselves with their value (no attribute), simple features need one. A
  // viz switch would otherwise leave a stale attribute (cells silently
  // unlabeled) or a dead attribute-less label — normalize here so the UI,
  // the API, and the assistant all get the same rule.
  {
    const nextViz = fields.viz ?? layer.viz;
    const nextStyle = fields.style ?? layer.style;
    if (nextStyle.label) {
      if (isAggregated(nextViz) && nextStyle.label.attribute !== undefined) {
        const label = { ...nextStyle.label };
        delete label.attribute;
        fields = { ...fields, style: { ...nextStyle, label } };
      } else if (
        !isAggregated(nextViz) &&
        nextStyle.label.attribute === undefined
      ) {
        const style = { ...nextStyle };
        delete style.label;
        fields = { ...fields, style };
      }
    }
  }

  // Label overrides are per slot; when the legend's structure changes they
  // stop matching and would make the legend lie — reset to automatic.
  const before = legendSlotCount(
    effectiveStyle(layer.style, layer.viz),
    layer.viz,
  );
  const after = legendSlotCount(
    effectiveStyle(fields.style ?? layer.style, fields.viz ?? layer.viz),
    fields.viz ?? layer.viz,
  );
  if (
    fields.legendLabels === undefined &&
    layer.legendLabels !== null &&
    after !== before
  ) {
    fields = { ...fields, legendLabels: null };
  }

  // Attribute-name overrides are per channel; when a channel's driving
  // attribute changes (or the channel goes away) its override would name
  // the wrong variable — drop just that channel's override.
  if (fields.legendAttrs === undefined && layer.legendAttrs !== null) {
    const stale = staleLegendAttrs(
      layer.legendAttrs,
      effectiveStyle(layer.style, layer.viz),
      effectiveStyle(fields.style ?? layer.style, fields.viz ?? layer.viz),
    );
    if (stale !== undefined) fields = { ...fields, legendAttrs: stale };
  }

  let fresh!: Layer;
  let committed = false;
  metadataDb().transaction(() => {
    // The before-image is read here, inside the commit, not from the entry
    // snapshot: the engine work above yields, and a concurrent write to the
    // same layer may have landed since. History must diff against the state
    // this write actually replaces, or undo restores a state that never
    // existed.
    const prior = requireLayer(scope, id);
    // The derivations above were computed against the entry snapshot. If
    // the layer moved while they settled, committing them would overwrite
    // the concurrent write with stale derived containers — abort and let
    // the caller re-derive against the fresh state.
    if (stableJson(prior) !== stableJson(layer)) return;
    updateLayerFields(id, fields);
    fresh = requireLayer(scope, id);
    // Record what actually changed, as stored — post-normalization, so a
    // redo re-applies exactly what this write produced. The keys cover
    // the request plus the coupled adjustments folded into `fields`
    // above; a write that changes nothing records nothing.
    const keys = Object.keys(fields).filter(
      (k) => (fields as Record<string, unknown>)[k] !== undefined,
    );
    const diff = diffImages(
      prior as unknown as Record<string, unknown>,
      fresh as unknown as Record<string, unknown>,
      keys,
    );
    if (diff) {
      recordStep({
        mapId: layer.mapId,
        scope: "layer",
        targetId: id,
        op: "update",
        before: diff.before,
        after: diff.after,
        groupId: opts.groupId,
      });
    }
    committed = true;
  })();
  return committed ? fresh : null;
}

/**
 * Resolve the extrusion's value range over the cells, so a height means
 * the same thing across the whole layer. When it cannot resolve (bad
 * attribute, empty result), the extrusion drops rather than render
 * heights that lie.
 */
async function settledElevation(
  scope: DatasetScope,
  input: { sql: string; filters: LayerFilter[]; viz: AggregatedViz },
  geometryColumn: string,
  signal?: AbortSignal,
): Promise<CellElevation | undefined> {
  const elevation = input.viz.elevation;
  if (!elevation) return undefined;
  try {
    const sql = effectiveSql(input, geometryColumn);
    const scale = await computeSizeScale(scope,
      sql,
      AGG_ELEV,
      [0, elevation.height],
      signal,
    );
    return { ...elevation, domain: scale.domain };
  } catch (error) {
    // A timed-out or cancelled evaluation is not a resolution failure —
    // dropping the extrusion would present the bound as a settled answer.
    if (isBoundedOutcome(error)) throw error;
    return undefined;
  }
}

/** Ramp choices worth carrying across aggregation changes. */
function priorAggregatedFill(layer: Layer): FillPaint | undefined {
  if (isAggregated(layer.viz)) return layer.viz.fill;
  // Entering aggregation from a simple visualization is a type switch: the
  // fill's ramp choices — scale mode, palette, reverse — survive where they
  // still apply. Categorical fills don't: the aggregate value is numeric,
  // so they fall back to the default ramp as before.
  return layer.style.fill.type === "quantile" ||
    layer.style.fill.type === "continuous"
    ? layer.style.fill
    : undefined;
}

/**
 * Fill for an aggregated layer, classified over the aggregate value. When
 * classification cannot run (empty result, missing extension), fall back to
 * a constant so the layer stays usable — render reports its own errors.
 */
async function aggregatedFill(
  scope: DatasetScope,
  input: { sql: string; filters: LayerFilter[]; viz: AggregatedViz },
  geometryColumn: string,
  prior: FillPaint | undefined,
  style: LayerStyle,
  signal?: AbortSignal,
): Promise<FillPaint> {
  const fallback: FillPaint =
    style.fill.type === "constant"
      ? style.fill
      : { type: "constant", color: { r: 18, g: 147, b: 154, a: 1 } };
  try {
    const sql = effectiveSql(input, geometryColumn);
    const priorRamp = prior?.type === "quantile" ? prior : undefined;
    const priorCategorical = prior?.type === "categorical" ? prior : undefined;
    const priorContinuous = prior?.type === "continuous" ? prior : undefined;
    // A custom scale reclassifies from its base method — the aggregation
    // changed, so hand-set breaks no longer describe the values.
    const priorMethod = priorCategorical
      ? "categorical"
      : priorContinuous
        ? "continuous"
        : priorRamp?.method === "custom"
          ? (priorRamp.baseMethod ?? "quantile")
          : (priorRamp?.method ?? "quantile");
    const fresh = await classifyFill(scope,
      sql,
      AGG_VALUE,
      priorMethod,
      {
        palette:
          priorCategorical?.palette ??
          priorContinuous?.palette ??
          priorRamp?.palette,
        classes: priorRamp?.classes ?? priorRamp?.colors.length,
        reversed:
          priorCategorical?.reversed ??
          priorContinuous?.reversed ??
          priorRamp?.reversed,
      },
      signal,
    );
    // The scale mode survives reclassification; value-anchored adjustments
    // (clamp, center) re-derive from the new distribution, and log carries
    // over only while the fresh domain still supports it.
    if (
      fresh.type === "continuous" &&
      priorContinuous?.log === true &&
      fresh.domain[0] > 0
    ) {
      return { ...fresh, log: true };
    }
    return fresh;
  } catch (error) {
    // Same rule as settledElevation: the bound's outcomes propagate; only
    // genuine classification failures degrade to the constant fallback.
    if (isBoundedOutcome(error)) throw error;
    return fallback;
  }
}

/**
 * Reclassification caused by an authoritative filter change. An explicit
 * constant is user intent, not an automatic scale, so it survives unchanged;
 * every data-driven fill follows the established aggregate reclassification
 * path (including Custom returning to its remembered named method).
 */
async function filterSettledAggregatedFill(
  scope: DatasetScope,
  input: { sql: string; filters: LayerFilter[]; viz: AggregatedViz },
  geometryColumn: string,
  prior: FillPaint | undefined,
  style: LayerStyle,
  signal?: AbortSignal,
): Promise<FillPaint> {
  if (prior?.type === "constant") return prior;
  return aggregatedFill(scope, input, geometryColumn, prior, style, signal);
}

export { layerEffectiveSql, sliderPreviewData } from "./layer-preview";

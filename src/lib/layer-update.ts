import { documentFacts, type DocumentFacts } from "./metadata/document-facts";
import { recordDocumentChanges } from "@/lib/metadata/revisions";
import { mapEvaluation, type DatasetScope } from "@/lib/query/access";
import type { AccountScope } from "@/lib/auth/scope";
import { requireLayerFor } from "./layer-access";
import {
  admitLayerCommit,
  admitLayerUpdate,
  type UpdateLayerFields,
} from "./layer-admission";
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
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import { classifyFill, computeSizeScale, paletteAvailable, type ClassifyOptions } from "@/lib/style/classify";
import {
  AGG_VALUE,
  AGG_ELEV,
  isAggregated,
  isOdViz,
  effectiveStyle,
  type LayerFilter,
  type AggregatedViz,
  type CellElevation,
  type LegendAttrs,
  type LegendChannelKey,
} from "@/lib/viz";
import { legendFor, legendSlotCount } from "@/lib/style/legend";

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

export async function deriveAndCommitUpdate(
  scope: AccountScope,
  id: string,
  fields: UpdateLayerFields,
  opts: { groupId?: string | null; signal?: AbortSignal; expectedRevision?: unknown } = {},
): Promise<Layer & DocumentFacts> {
  // Admission (layer-admission.ts): the layer under the acting scope,
  // changed SQL that still draws geometry, a valid style normalized, and
  // the references this request introduces resolving against the schema
  // as it leaves it, all before the derivations below.
  const admitted = await admitLayerUpdate(scope, id, fields, opts.signal, opts.expectedRevision);
  const layer = admitted.layer, evaluation = mapEvaluation(scope, layer.mapId);
  fields = admitted.fields;
  // A repeated write of the same filter image is a true no-op: in
  // particular, it must not turn into a classification-only history step.
  // stableJson makes this insensitive to object key order at the API edge.
  const filtersChanged =
    fields.filters !== undefined &&
    stableJson(fields.filters) !== stableJson(layer.filters);
  if (
    fields.viz !== undefined &&
    fields.viz.type !== "points" &&
    !isOdViz(fields.viz)
  ) {
    // Hexbin, grid, and heatmap draw point results; line and polygon layers
    // keep simple rendering. Arc/line ignore the primary geometry entirely
    // — their endpoints are mapped.
    const inspection = await inspectLayerGeometry(evaluation,
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
        viz.fill = await filterSettledAggregatedFill(evaluation,
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
        viz.fill = await aggregatedFill(evaluation,
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
          : await settledElevation(evaluation,
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
    const inspection = await inspectLayerGeometry(evaluation,
      fields.sql ?? layer.sql,
      opts.signal,
    );
    const viz = { ...layer.viz };
    viz.fill = await filterSettledAggregatedFill(evaluation,
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
      viz.elevation = await settledElevation(evaluation,
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

  return metadataDb().transaction(() => {
    // The accepted basis must still be the one used for validation and
    // derivation. Permission and SQL admission are rechecked first.
    const prior = admitLayerCommit(scope, id, layer, fields, opts.expectedRevision);
    updateLayerFields(id, fields);
    const fresh = requireLayerFor(scope, id, "edit");
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
      recordDocumentChanges(scope, [{ kind: "map", id: layer.mapId }]);
      recordStep({
        mapId: layer.mapId,
        scope: "layer",
        targetId: id,
        op: "update",
        before: diff.before,
        after: diff.after,
        groupId: opts.groupId,
      }, metadataDb(), scope);
    }
    return { ...fresh, ...documentFacts({ kind: "map", id: layer.mapId }) };
  })();
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
 * The palette a reclassification carries over from the prior fill. A saved
 * palette deleted since the layer was styled cannot be asked for by name:
 * the layer's own stored colors stand in for it (the fill keeps the name),
 * or, with none stored, the default palette does.
 */
function priorPalette(prior: FillPaint | undefined): Pick<ClassifyOptions, "palette" | "colors"> {
  if (!prior || prior.type === "constant") return {};
  const kind = prior.type === "categorical" ? "categorical" : "sequential";
  if (paletteAvailable(prior.palette, kind)) return { palette: prior.palette };
  const own = prior.type === "quantile" ? { stops: prior.colors }
    : prior.type === "continuous" ? { stops: prior.stops, positions: prior.positions }
      : null;
  return own && own.stops.length > 0 ? { palette: prior.palette, colors: own } : {};
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
        ...priorPalette(prior),
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


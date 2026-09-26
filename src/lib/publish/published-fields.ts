import { liveFilters } from "@/lib/live-filters";
import {
  AGG_COUNT,
  AGG_ELEV,
  AGG_VALUE,
  isAggregated,
  type LayerFilter,
  type LayerViz,
} from "@/lib/viz";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import type { MapTimeline } from "@/lib/timeline";
import type { MapWidget } from "@/lib/widgets";

/**
 * The effective published field set. "Publish this map" means "publish what
 * the reader can see" — every published response that carries feature data
 * carries exactly this set as properties, nothing more. One derivation for
 * every consumer: the inline render, the tile build, the published
 * boundary's selection check, and the publish surface's statement all read
 * this module, so they cannot drift from one another.
 */

/** Automatic tooltip picks the first few properties. One constant for the
 * canvas rule and the server derivation — the projection preserves result
 * order, so the client's first-N slice lands on the same fields whether it
 * runs over the author's full wire or the reader's projected one. */
export const AUTO_TOOLTIP_FIELDS = 8;

/** The reserved property names the automatic rule never counts — the
 * server-computed label anchor and the extrusion value, mirroring the
 * canvas filter exactly. */
const AUTO_STRIPPED = new Set(["__anchor", AGG_ELEV]);

/** The fields the automatic tooltip shows over a wire carrying `columns`. */
export function autoInteractionFields(columns: string[]): string[] {
  return columns
    .filter((c) => !AUTO_STRIPPED.has(c))
    .slice(0, AUTO_TOOLTIP_FIELDS);
}

export interface PublishedProjectionInput {
  layerId: string;
  style: LayerStyle;
  viz: LayerViz;
  filters: LayerFilter[];
  /** Hover fields; null = automatic. */
  tooltip: string[] | null;
  /** Click fields; null = automatic. */
  popup: string[] | null;
  /** The author's explicit published-field list; null = derived default. */
  publishedFields: string[] | null;
  /** The map's docked timeline, whichever layer it targets. */
  timeline: MapTimeline | null;
  /** The map's widgets, whichever layers they read. */
  widgets: MapWidget[];
  /** Whether widgets ship with the published view at all. */
  widgetsPublished: boolean;
  /** Non-geometry result columns of the layer's SQL, in result order. */
  columns: string[];
}

function paintAttribute(paint: FillPaint | undefined): string | null {
  if (!paint || paint.type === "constant") return null;
  return paint.attribute;
}

/**
 * The per-feature attributes the canvas actually reads for a viz's style
 * channels. Heatmaps read none — their gradient is self-contained and
 * only the weight enters per feature. Clusters read none either: bubbles
 * and dissolved points take a constant summary color and a count-scaled
 * radius, never per-feature paint; only the cluster color aggregate reads
 * an attribute per leaf. Everything else — simple features, icon,
 * arc/line — rides the standard channels. Stale channel config on a viz
 * that ignores it must not force-publish columns.
 */
function styleChannelAttributes(
  style: LayerStyle,
  viz: LayerViz,
): (string | null)[] {
  if (viz.type === "heatmap") return [viz.weight];
  if (viz.type === "cluster") {
    return [
      viz.color !== "fixed" && "attribute" in viz.color
        ? viz.color.attribute
        : null,
    ];
  }
  return [
    paintAttribute(style.fill),
    paintAttribute(style.strokeBy),
    style.pointRadiusBy?.attribute ?? null,
    style.strokeWidthBy?.attribute ?? null,
    style.heightBy?.attribute ?? null,
    style.label?.attribute ?? null,
    // The thinning priority: readers apply the same ranking the builder
    // does, so the column their thinning reads must ride.
    style.label?.priorityField ?? null,
  ];
}

/** Whether the viz has a hover/click surface at all. Heatmaps are not
 * pickable — no discrete features to hover — so no tooltip or pop-up
 * field is ever "what the reader can see" on one. */
function hasInteraction(viz: LayerViz): boolean {
  return viz.type !== "heatmap";
}

/**
 * The fields the published map cannot function without: everything the
 * viewer reads from feature properties to draw, label, and filter. This
 * core is invariant under the author override — no override can break the
 * published rendering. Fields consumed only server-side — SQL-applied
 * filters, ranking aggregation fields, origin/destination coordinates —
 * are deliberately absent, as are style channels the current viz does not
 * render.
 */
function functionalCore(input: PublishedProjectionInput): Set<string> {
  const core = new Set<string>();
  const add = (field: string | null | undefined) => {
    if (field) core.add(field);
  };

  for (const attr of styleChannelAttributes(input.style, input.viz)) {
    add(attr);
  }

  // The docked field enters through the delegation below — and only
  // there: a dock whose timerange filter has drifted away degrades to no
  // timeline for readers, so its field is nothing a reader can use.
  const dockedField =
    input.timeline && input.timeline.layerId === input.layerId
      ? input.timeline.field
      : null;
  for (const f of liveFilters(input.viz, input.filters, dockedField)) {
    add(f.field);
  }

  if (input.widgetsPublished) {
    for (const w of input.widgets) {
      if (w.visible && w.layerId === input.layerId) add(w.field);
    }
  }
  return core;
}

/**
 * The effective published field set, in result-column order. Aggregated
 * layers (hex bins, grid) already publish only their computed columns —
 * returned as-is, the contract this module generalizes. For everything
 * else: the functional core plus, by default, the tooltip and pop-up
 * fields (automatic lists resolved to what the automatic rule shows), or,
 * under an author override, the core plus exactly the listed fields.
 * Always intersected with the columns that exist — a stale reference is
 * harmless here., writes refuse new references the schema cannot honor;
 * this intersection keeps tolerating drift that arrives after the write.
 */
/** The layer configuration the projection reads — `Layer` satisfies it. */
export interface PublishedLayerConfig {
  id: string;
  style: LayerStyle;
  viz: LayerViz;
  filters: LayerFilter[];
  tooltip: string[] | null;
  popup: string[] | null;
  publishedFields: string[] | null;
}

/** The map-level state the projection reads — `MapRecord` satisfies it. */
export interface PublishedMapContext {
  timeline: MapTimeline | null;
  widgets: MapWidget[];
  widgetsPublished: boolean;
}

/** The derivation, phrased for call sites that hold a layer and its map. */
export function publishedFieldsFor(
  layer: PublishedLayerConfig,
  map: PublishedMapContext,
  columns: string[],
): string[] {
  return effectivePublishedFields({
    layerId: layer.id,
    style: layer.style,
    viz: layer.viz,
    filters: layer.filters,
    tooltip: layer.tooltip,
    popup: layer.popup,
    publishedFields: layer.publishedFields,
    timeline: map.timeline,
    widgets: map.widgets,
    widgetsPublished: map.widgetsPublished,
    columns,
  });
}

export function effectivePublishedFields(
  input: PublishedProjectionInput,
): string[] {
  if (isAggregated(input.viz)) {
    return [
      AGG_VALUE,
      AGG_COUNT,
      ...(input.viz.elevation ? [AGG_ELEV] : []),
    ];
  }

  const wanted = functionalCore(input);
  if (input.publishedFields === null) {
    if (hasInteraction(input.viz)) {
      const auto =
        input.tooltip === null || input.popup === null
          ? autoInteractionFields(input.columns)
          : [];
      for (const f of input.tooltip ?? auto) wanted.add(f);
      for (const f of input.popup ?? auto) wanted.add(f);
    }
  } else {
    for (const f of input.publishedFields) wanted.add(f);
  }
  return input.columns.filter((c) => wanted.has(c));
}

/** What the publish surface states, per layer: the effective
 * set with the fields the published map cannot render without marked, the
 * mode, and what an explicit list could add. The UI merely renders this —
 * the statement is the API's. */
export interface PublishedFieldsStatement {
  mode: "derived" | "list";
  fields: { name: string; required: boolean }[];
  /** Every field an explicit list could name — the result's non-geometry
   * columns. Empty on aggregated layers: their computed columns are the
   * whole wire, and there is nothing to add. */
  available: string[];
  /** The author's raw explicit list, verbatim (null = derived). Editors
   * write against this, never against the effective set — a listed field
   * that is currently also required must survive unrelated edits (review
   * round one). */
  list: string[] | null;
}

export function publishedFieldsStatement(
  layer: PublishedLayerConfig,
  map: PublishedMapContext,
  columns: string[],
): PublishedFieldsStatement {
  const effective = publishedFieldsFor(layer, map, columns);
  if (isAggregated(layer.viz)) {
    return {
      mode: "derived",
      fields: effective.map((name) => ({ name, required: true })),
      available: [],
      list: layer.publishedFields,
    };
  }
  const core = functionalCore({
    layerId: layer.id,
    style: layer.style,
    viz: layer.viz,
    filters: layer.filters,
    tooltip: layer.tooltip,
    popup: layer.popup,
    publishedFields: layer.publishedFields,
    timeline: map.timeline,
    widgets: map.widgets,
    widgetsPublished: map.widgetsPublished,
    columns,
  });
  return {
    mode: layer.publishedFields === null ? "derived" : "list",
    fields: effective.map((name) => ({ name, required: core.has(name) })),
    available: columns,
    list: layer.publishedFields,
  };
}

/**
 * Canonical signature of every projection input EXCEPT the result columns.
 * Two states with equal signatures, equal effective SQL, and equal
 * referenced-artifact identities resolve to the same effective set — the
 * columns themselves are a function of those. The tile fingerprint folds
 * this string, and the published tile authorization recomputes it
 * synchronously from the same inputs: one function, two call sites, no
 * drift. Must mirror the derivation above branch for branch — a component
 * read there and unlisted here would let a stale archive read as fresh.
 */
export function publishedFieldsSignature(
  layer: PublishedLayerConfig,
  map: PublishedMapContext,
): string {
  if (isAggregated(layer.viz)) {
    return JSON.stringify({
      aggregated: true,
      elev: Boolean(layer.viz.elevation),
    });
  }
  const dockedField =
    map.timeline && map.timeline.layerId === layer.id
      ? map.timeline.field
      : null;
  // The derivation consumes lists as unordered sets, so the signature
  // canonicalizes them: reordering or duplicating the
  // same fields must not read as a data change and rebuild an archive.
  const canonical = (list: string[] | null) =>
    list === null ? null : [...new Set(list)].sort();
  return JSON.stringify({
    override: canonical(layer.publishedFields),
    // Interaction lists shape the set only in derived mode — and only on
    // a viz with a hover/click surface; under an override (or on a
    // heatmap) a tooltip edit must not read as a data change.
    interaction:
      layer.publishedFields === null && hasInteraction(layer.viz)
        ? [canonical(layer.tooltip), canonical(layer.popup)]
        : null,
    // The same channel model the functional core reads: a channel the
    // viz ignores never enters the fingerprint.
    style: styleChannelAttributes(layer.style, layer.viz),
    // The docked timeline needs no component of its own: its field is
    // guaranteed a delegated slot, so `live` already carries it — and
    // docking/undocking without changing the delegated set must not read
    // as a data change.
    live: liveFilters(layer.viz, layer.filters, dockedField)
      .map((f) => f.field)
      .sort(),
    widgets: map.widgetsPublished
      ? map.widgets
          .filter((w) => w.visible && w.layerId === layer.id && w.field)
          .map((w) => w.field)
          .sort()
      : [],
  });
}

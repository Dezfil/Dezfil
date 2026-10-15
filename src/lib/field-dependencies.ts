import { liveFilters } from "@/lib/live-filters";
import {
  AGG_COUNT,
  AGG_ELEV,
  AGG_VALUE,
  isAggregated,
  type AggregatedViz,
  type LayerFilter,
  type LayerViz,
} from "@/lib/viz";
import type { FillPaint, LayerStyle } from "@/lib/style/style";
import type { MapTimeline } from "@/lib/timeline";
import type { MapWidget } from "@/lib/widgets";

/**
 * Which result columns a layer answer carries as feature properties. The
 * primitives below each name one thing a map reads from a feature; three
 * audience policies combine them, and every answer that carries feature
 * data reads exactly one of the policies:
 *
 * - private: the builder's own map carries what the layer itself uses,
 *   plus the map's widgets and timeline on it and the identity sketch
 *   selection needs. The published override neither narrows nor widens it.
 * - published: what a reader can see, which is the functional core, the
 *   interaction fields or the author's override, and visible published
 *   widgets.
 * - shared tile archive: one archive serves the builder and readers, so it
 *   carries the published set and folds the published signature.
 *
 * Every policy keeps result order: the automatic interaction rule slices
 * the first fields of whatever wire it runs over, and a subset in result
 * order that contains those first fields slices to the same ones.
 */

/** Automatic tooltip picks the first few properties. One constant for the
 * canvas rule and the server derivation. */
export const AUTO_TOOLTIP_FIELDS = 8;

/** The reserved property names the automatic rule never counts: the
 * server-computed label anchor and the extrusion value, mirroring the
 * canvas filter exactly. */
const AUTO_STRIPPED = new Set(["__anchor", AGG_ELEV]);

/** The fields the automatic tooltip shows over a wire carrying `columns`. */
export function autoInteractionFields(columns: string[]): string[] {
  return columns
    .filter((c) => !AUTO_STRIPPED.has(c))
    .slice(0, AUTO_TOOLTIP_FIELDS);
}

/** The layer configuration the policies read. `Layer` satisfies it. */
export interface FieldLayerConfig {
  id: string;
  style: LayerStyle;
  viz: LayerViz;
  filters: LayerFilter[];
  /** Hover fields; null = automatic. */
  tooltip: string[] | null;
  /** Click fields; null = automatic. */
  popup: string[] | null;
  /** The author's explicit published-field list; null = derived default. */
  publishedFields: string[] | null;
}

/** The map-level state the private policy reads. */
export interface PrivateMapContext {
  /** The map's docked timeline, whichever layer it targets. */
  timeline: MapTimeline | null;
  /** The map's widgets, whichever layers they read. */
  widgets: MapWidget[];
}

/** The map-level state the published and tile-archive policies read.
 * `MapRecord` satisfies it. */
export interface PublishedMapContext extends PrivateMapContext {
  /** Whether widgets ship with the published view at all. */
  widgetsPublished: boolean;
}

function paintAttribute(paint: FillPaint | undefined): string | null {
  if (!paint || paint.type === "constant") return null;
  return paint.attribute;
}

/**
 * The per-feature attributes the canvas actually reads for a viz's style
 * channels. Heatmaps read none: their gradient is self-contained and only
 * the weight enters per feature. Clusters read none either: bubbles and
 * dissolved points take a constant summary color and a count-scaled
 * radius, never per-feature paint; only the cluster color aggregate reads
 * an attribute per leaf. Everything else (simple features, icon, arc and
 * line) rides the standard channels, labels and their thinning priority
 * included. Stale channel config on a viz that ignores it is not read.
 */
export function styleChannelAttributes(
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
    // The thinning priority: the canvas ranks labels by it.
    style.label?.priorityField ?? null,
  ];
}

/** Whether the viz has a hover and click surface at all. Heatmaps are not
 * pickable, with no discrete feature to hover, so no tooltip or pop-up
 * field is ever read on one. */
export function hasInteraction(viz: LayerViz): boolean {
  return viz.type !== "heatmap";
}

/** The field of the map's timeline when it is docked to this layer. */
export function dockedTimelineField(
  layerId: string,
  timeline: MapTimeline | null,
): string | null {
  return timeline && timeline.layerId === layerId ? timeline.field : null;
}

/** The fields of the filters the canvas applies itself: the delegated
 * live filters, the docked timeline's window among them. Filters applied
 * in SQL read nothing from the wire. */
export function liveFilterFields(
  layer: Pick<FieldLayerConfig, "id" | "viz" | "filters">,
  timeline: MapTimeline | null,
): string[] {
  return liveFilters(
    layer.viz,
    layer.filters,
    dockedTimelineField(layer.id, timeline),
  ).map((f) => f.field);
}

/** The fields the map's widgets read from this layer's features: a
 * widget's selection filters the canvas by its field. A ranking
 * aggregation field is evaluated on the server and never read here. */
export function layerWidgetFields(
  layerId: string,
  widgets: MapWidget[],
  visibleOnly = false,
): string[] {
  return widgets
    .filter((w) => w.layerId === layerId && w.field && (!visibleOnly || w.visible))
    .map((w) => w.field as string);
}

/** An aggregation's computed columns, which are its whole wire on every
 * audience. */
export function computedFields(viz: AggregatedViz): string[] {
  return [AGG_VALUE, AGG_COUNT, ...(viz.elevation ? [AGG_ELEV] : [])];
}

/** The interaction fields: explicit lists as given, automatic lists
 * resolved to what the automatic rule shows over the full result. */
function interactionFields(
  layer: Pick<FieldLayerConfig, "viz" | "tooltip" | "popup">,
  columns: string[],
): string[] {
  if (!hasInteraction(layer.viz)) return [];
  const auto =
    layer.tooltip === null || layer.popup === null
      ? autoInteractionFields(columns)
      : [];
  return [...(layer.tooltip ?? auto), ...(layer.popup ?? auto)];
}

/** Drawn sketch rows carry their stable identity and kind as real columns;
 * picking a drawn shape for selection and vertex editing reads both. */
function sketchIdentity(columns: string[]): string[] {
  return columns.includes("feature_id") && columns.includes("kind")
    ? ["feature_id", "kind"]
    : [];
}

/** What the private policy needs from a layer's result, before the
 * result's columns are known: the fields it names, and whether automatic
 * interactions add the first fields of the result. */
export interface PrivateFieldNeeds {
  names: Set<string>;
  automatic: boolean;
}

/** The private policy's needs under a layer's configuration and its map. */
export function privateFieldNeeds(
  layer: FieldLayerConfig,
  map: PrivateMapContext,
): PrivateFieldNeeds {
  if (isAggregated(layer.viz)) {
    return { names: new Set(computedFields(layer.viz)), automatic: false };
  }
  const interactive = hasInteraction(layer.viz);
  const names = new Set<string>([
    ...(interactive ? [...(layer.tooltip ?? []), ...(layer.popup ?? [])] : []),
    ...liveFilterFields(layer, map.timeline),
    ...layerWidgetFields(layer.id, map.widgets),
  ]);
  for (const field of styleChannelAttributes(layer.style, layer.viz)) {
    if (field) names.add(field);
  }
  const docked = dockedTimelineField(layer.id, map.timeline);
  if (docked) names.add(docked);
  return {
    names,
    automatic: interactive && (layer.tooltip === null || layer.popup === null),
  };
}

/** Whether a render built under `before` may lack a field `after` reads:
 * a newly named field, or automatic interactions where there were none. A
 * change that only drops needs never does. */
export function widensPrivateFields(
  before: PrivateFieldNeeds,
  after: PrivateFieldNeeds,
): boolean {
  if (after.automatic && !before.automatic) return true;
  for (const name of after.names) if (!before.names.has(name)) return true;
  return false;
}

/**
 * The private policy: the fields the builder's own map reads from this
 * layer, in result order. Its style channels and labels, the filters the
 * canvas applies, the docked timeline, every widget on the layer, the
 * interaction fields (automatic ones by the existing rule and order) and
 * a drawn sketch's identity. The published override plays no part.
 * Aggregations carry their computed columns, as on every audience.
 */
export function privateLayerFields(
  layer: FieldLayerConfig,
  map: PrivateMapContext,
  columns: string[],
): string[] {
  const needs = privateFieldNeeds(layer, map);
  if (isAggregated(layer.viz)) return [...needs.names];
  const wanted = new Set<string>([
    ...needs.names,
    ...(needs.automatic ? autoInteractionFields(columns) : []),
    ...sketchIdentity(columns),
  ]);
  return columns.filter((c) => wanted.has(c));
}

/**
 * The fields the published map cannot function without: everything the
 * viewer reads from feature properties to draw, label, and filter. This
 * core is invariant under the author override, so no override can break
 * the published rendering. Fields consumed only server-side (SQL-applied
 * filters, ranking aggregation fields, origin and destination
 * coordinates) are deliberately absent, as are style channels the current
 * viz does not render. The docked field enters through the live filters
 * only: a dock whose timerange filter has drifted away degrades to no
 * timeline for readers, so its field is nothing a reader can use.
 */
export function publishedFunctionalCore(
  layer: FieldLayerConfig,
  map: PublishedMapContext,
): Set<string> {
  const core = new Set<string>();
  for (const field of styleChannelAttributes(layer.style, layer.viz)) {
    if (field) core.add(field);
  }
  for (const field of liveFilterFields(layer, map.timeline)) core.add(field);
  if (map.widgetsPublished) {
    for (const field of layerWidgetFields(layer.id, map.widgets, true)) {
      core.add(field);
    }
  }
  return core;
}

/**
 * The published policy, in result order. Aggregations publish their
 * computed columns. Otherwise the functional core plus, by default, the
 * tooltip and pop-up fields (automatic lists resolved to what the
 * automatic rule shows), or, under an author override, the core plus
 * exactly the listed fields. Always intersected with the columns that
 * exist: writes refuse new references the schema cannot honor, and this
 * intersection tolerates drift that arrives after the write.
 */
export function publishedLayerFields(
  layer: FieldLayerConfig,
  map: PublishedMapContext,
  columns: string[],
): string[] {
  if (isAggregated(layer.viz)) return computedFields(layer.viz);
  const wanted = publishedFunctionalCore(layer, map);
  const chosen =
    layer.publishedFields === null
      ? interactionFields(layer, columns)
      : layer.publishedFields;
  for (const field of chosen) wanted.add(field);
  return columns.filter((c) => wanted.has(c));
}

/**
 * Canonical signature of every published-policy input except the result
 * columns. Two states with equal signatures, equal effective SQL, and
 * equal referenced-artifact identities resolve to the same field set; the
 * columns themselves are a function of those. Must mirror the published
 * policy branch for branch: a component read there and unlisted here
 * would let a stale archive read as fresh.
 */
export function publishedSignature(
  layer: FieldLayerConfig,
  map: PublishedMapContext,
): string {
  if (isAggregated(layer.viz)) {
    return JSON.stringify({
      aggregated: true,
      elev: Boolean(layer.viz.elevation),
    });
  }
  // The policy consumes lists as unordered sets, so the signature
  // canonicalizes them: reordering or duplicating the same fields must not
  // read as a data change and rebuild an archive.
  const canonical = (list: string[] | null) =>
    list === null ? null : [...new Set(list)].sort();
  return JSON.stringify({
    override: canonical(layer.publishedFields),
    // Interaction lists shape the set only in derived mode, and only on a
    // viz with a hover and click surface; under an override (or on a
    // heatmap) a tooltip edit must not read as a data change.
    interaction:
      layer.publishedFields === null && hasInteraction(layer.viz)
        ? [canonical(layer.tooltip), canonical(layer.popup)]
        : null,
    // The same channel model the functional core reads: a channel the viz
    // ignores never enters the fingerprint.
    style: styleChannelAttributes(layer.style, layer.viz),
    // The docked timeline needs no component of its own: its field enters
    // the set only as a delegated live filter, which `live` carries, and
    // docking or undocking without changing that set must not read as a
    // data change.
    live: liveFilterFields(layer, map.timeline).sort(),
    widgets: map.widgetsPublished
      ? layerWidgetFields(layer.id, map.widgets, true).sort()
      : [],
  });
}

/** The shared tile archive policy: one archive serves the builder and
 * readers, so its properties are the published set, whichever audience
 * triggered the build. */
export function tileArchiveFields(
  layer: FieldLayerConfig,
  map: PublishedMapContext,
  columns: string[],
): string[] {
  return publishedLayerFields(layer, map, columns);
}

/** The archive's projection signature, folded into its fingerprint; the
 * published tile authorization recomputes it from the same inputs. */
export function tileArchiveSignature(
  layer: FieldLayerConfig,
  map: PublishedMapContext,
): string {
  return publishedSignature(layer, map);
}

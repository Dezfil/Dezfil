/**
 * Basemap layer groups: fixed named groups of basemap content, each
 * toggleable per map. Shared by the service validation, the builder UI,
 * and the canvas, so this module must stay dependency-free (it reaches the
 * client bundle).
 */

export const BASEMAP_LAYER_GROUPS = [
  "labels",
  "roads",
  "borders",
  "buildings",
  "water",
  "land",
] as const;

export type BasemapLayerGroup = (typeof BASEMAP_LAYER_GROUPS)[number];

/** Per-group visibility; a missing key means visible. Stored values keep
 * only the hidden (false) entries — null means everything visible, which is
 * every earlier map. */
export type BasemapLayers = Partial<Record<BasemapLayerGroup, boolean>>;

export function isBasemapLayerGroup(
  value: unknown,
): value is BasemapLayerGroup {
  return BASEMAP_LAYER_GROUPS.includes(value as BasemapLayerGroup);
}

export const BASEMAP_LAYER_GROUP_LABELS: Record<BasemapLayerGroup, string> = {
  labels: "Labels",
  roads: "Roads",
  borders: "Borders",
  buildings: "Buildings",
  water: "Water",
  land: "Land",
};

/**
 * Whether the group toggles act on a style of this kind. Imagery has no
 * OpenMapTiles groups to hide — worse, its raster photo classifies as
 * Land below, so applying toggles there would let a saved "hide Land"
 * blank the whole satellite. The canvas skips application entirely on
 * imagery; saved state is preserved for vector styles.
 */
export function basemapLayersApply(kind: "vector" | "imagery"): boolean {
  return kind === "vector";
}

/** The slice of a MapLibre style layer the classifier reads. */
export interface StyleLayerLike {
  id: string;
  type: string;
  "source-layer"?: string;
}

/** OpenMapTiles source-layers → groups, for everything that isn't a label. */
const SOURCE_LAYER_GROUPS: Record<string, BasemapLayerGroup> = {
  transportation: "roads",
  aeroway: "roads",
  boundary: "borders",
  building: "buildings",
  water: "water",
  waterway: "water",
  landcover: "land",
  landuse: "land",
  park: "land",
};

/**
 * Which group a basemap style layer belongs to; null means none — an
 * unrecognized layer is never hidden (fails open to visible). Classification
 * keys off content and rendering type, not layer ids, so it holds across the
 * bundled styles (they share the OpenMapTiles schema but not layer ids):
 * - text/icon (symbol) layers are labels, except transportation-sourced
 *   symbols (one-way arrows), which belong with the roads that carry them;
 * - raster layers are the low-zoom earth backdrop — land imagery;
 * - the background layer stays unclassified so the canvas never goes blank.
 */
export function classifyBasemapLayer(
  layer: StyleLayerLike,
): BasemapLayerGroup | null {
  const source = layer["source-layer"];
  if (layer.type === "symbol") {
    return source === "transportation" ? "roads" : "labels";
  }
  if (layer.type === "raster") return "land";
  return (source && SOURCE_LAYER_GROUPS[source]) || null;
}

/**
 * Which groups a loaded style actually yields: the set the classifier
 * finds across its layers. The panel marks the rest "not in this style"
 * when a custom style is active — present groups stay live, absent ones
 * degrade honestly instead of toggling nothing.
 */
export function presentBasemapGroups(
  layers: StyleLayerLike[],
): BasemapLayerGroup[] {
  const present = new Set<BasemapLayerGroup>();
  for (const layer of layers) {
    const group = classifyBasemapLayer(layer);
    if (group) present.add(group);
  }
  return BASEMAP_LAYER_GROUPS.filter((g) => present.has(g));
}

export type BasemapLayerVisibility = "visible" | "none";

/**
 * A style's authored visibilities, read at style load before anything
 * touches them, so hidden groups re-apply over the style's own truth —
 * initial load, basemap change, theme switch, offline fallback alike.
 * Each map instance keeps its own record: the live canvas across its
 * style swaps, an offscreen ground for its one load.
 */
export function authoredBasemapVisibility(
  layers: { id: string; layout?: { visibility?: string } }[],
): Map<string, BasemapLayerVisibility> {
  return new Map(
    layers.map((l) => [l.id, l.layout?.visibility === "none" ? "none" : "visible"]),
  );
}

/**
 * Which visibility each classified style layer should have under the
 * map's group toggles: hidden when its group is toggled off, else its
 * authored visibility (an instance with no record for the layer reads it
 * as visible). Unrecognized content is never listed, so it is never
 * hidden; imagery yields nothing. The decision only — the caller
 * compares against the renderer and sets what differs.
 */
export function basemapLayerVisibilities(opts: {
  kind: "vector" | "imagery";
  layers: StyleLayerLike[];
  toggles: BasemapLayers | null;
  authored: (layerId: string) => BasemapLayerVisibility | undefined;
}): { id: string; visibility: BasemapLayerVisibility }[] {
  if (!basemapLayersApply(opts.kind)) return [];
  const toggles = opts.toggles ?? {};
  const out: { id: string; visibility: BasemapLayerVisibility }[] = [];
  for (const layer of opts.layers) {
    const group = classifyBasemapLayer(layer);
    if (!group) continue;
    out.push({
      id: layer.id,
      visibility:
        toggles[group] === false ? "none" : (opts.authored(layer.id) ?? "visible"),
    });
  }
  return out;
}

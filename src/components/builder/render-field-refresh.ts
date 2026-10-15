import { liveFilters } from "@/lib/live-filters";
import {
  dockedTimelineField,
  privateFieldNeeds,
  widensPrivateFields,
  type PrivateMapContext,
} from "@/lib/field-dependencies";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { LayerRenderData } from "./render-data";

/**
 * When an edit needs the layer's render again for what its features carry.
 * An inline render carries only the fields the layer and its map read (the
 * private field policy), so an edit that makes the layer read a field its
 * last render was built without asks for a new render, whatever else the
 * edit changes. A tiled render carries the shared archive's fields and
 * keeps its own refresh rule.
 *
 * The comparison is between the accepted state before the edit and after
 * it. A render shown for the earlier state carries what that state needed,
 * an edit that only drops needs leaves it sufficient, and one that adds a
 * need asks again, so what is shown always carries what the accepted state
 * reads once its newest answer lands.
 */

const NO_MAP: PrivateMapContext = { timeline: null, widgets: [] };

/** A render shown inline. A layer with no render has nothing shown to be
 * short of a field: the builder asks for every layer's first render after
 * the accepted state it is to read. */
function inline(render: LayerRenderData | undefined): boolean {
  return render !== undefined && render.tiles === undefined;
}

/** Whether a layer edit makes an inline layer read a field its last render
 * may lack: a style channel, a label or its priority, an interaction field
 * or automatic interactions, a filter the canvas applies. */
export function layerEditNeedsRender(
  before: Layer,
  after: Layer,
  map: PrivateMapContext | null,
  render: LayerRenderData | undefined,
): boolean {
  if (!inline(render)) return false;
  const context = map ?? NO_MAP;
  return widensPrivateFields(
    privateFieldNeeds(before, context),
    privateFieldNeeds(after, context),
  );
}

/**
 * The layers a map edit needs to render again, in map order. A timeline
 * dock that shifts which filters the canvas applies changes the query of
 * any layer, tiled or inline; a widget or timeline edit that makes an
 * inline layer read a field its last render may lack changes what its
 * features must carry.
 */
export function mapEditRenders(
  before: PrivateMapContext | null,
  after: MapWithLayers,
  renders: Readonly<Record<string, LayerRenderData>>,
): string[] {
  const prior = before ?? NO_MAP;
  return after.layers
    .filter((layer) => {
      if (!renders[layer.id]) return false;
      const was = liveFilters(layer.viz, layer.filters, dockedTimelineField(layer.id, prior.timeline));
      const is = liveFilters(layer.viz, layer.filters, dockedTimelineField(layer.id, after.timeline));
      if (was.length !== is.length || was.some((filter, i) => filter !== is[i])) return true;
      return (
        inline(renders[layer.id]) &&
        widensPrivateFields(privateFieldNeeds(layer, prior), privateFieldNeeds(layer, after))
      );
    })
    .map((layer) => layer.id);
}

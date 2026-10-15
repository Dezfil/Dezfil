import type * as maplibregl from "maplibre-gl";
import type { PickingInfo } from "@deck.gl/core";
import type { MutableRefObject } from "react";
import { AUTO_TOOLTIP_FIELDS } from "@/lib/field-dependencies";
import { formatCompact } from "@/lib/style/legend";
import { pickOwner } from "./pick-owner";
import type { RenderedLayer } from "./MapCanvas";

/**
 * Pointer-interaction coordination for the canvas — the hover tooltip,
 * the pinned pop-up, cluster zoom and the pick seam — extracted from
 * MapCanvas at the touch (the decomposition rule: the feature that
 * touches the monster file extracts the piece it works on). Behavior is
 * unchanged except the seam itself: a pick now carries the clicked
 * feature's stable identity (its `feature_id` and drawn `kind`
 * properties, when the layer's render projects them) beside the owning
 * layer id, which is what the draw select tool reads. Established order
 * holds: Select-mode consumption first, then cluster zoom, then the
 * pop-up.
 */

export interface HoverInfo {
  x: number;
  y: number;
  entries: [string, unknown][];
}

/** A click-pinned pop-up: anchored to a map coordinate so it
 * rides along as the view moves; layerId+index identify the feature so the
 * hover tooltip can stay quiet for it. */
export interface PinnedPopup {
  lng: number;
  lat: number;
  x: number;
  y: number;
  layerId: string;
  index: number;
  entries: [string, unknown][];
}

/** The clicked feature's stable identity, when its layer projects one
 * sketch rows carry feature_id and kind as real columns. */
export interface PickedFeature {
  featureId: string | null;
  kind: string | null;
}

export type FeaturePickHandler = (
  layerId: string,
  feature: PickedFeature,
) => boolean;

/** Field rows for the tooltip and the pop-up — one rule for both. Null
 * fields = automatic first few (the count shared with the published
 * projection,); reserved properties never show. */
export function fieldEntries(
  props: Record<string, unknown>,
  fields: string[] | null,
  tiled: boolean,
  dropValue = false,
): [string, unknown][] {
  return fields === null
    ? Object.entries(props)
        // layerName is deck's MVT metadata; __anchor is the server-computed
        // label anchor; elev is the reserved extrusion value — none of them
        // are data.
        .filter(
          ([k]) =>
            k !== "__anchor" && k !== "elev" && !(tiled && k === "layerName"),
        )
        // A count-aggregated cell's value IS its count — one row, not two
        // identical numbers.
        .filter(([k]) => !(dropValue && k === "value"))
        .slice(0, AUTO_TOOLTIP_FIELDS)
    : fields.filter((f) => f in props).map((f) => [f, props[f]]);
}

/** True when a layer draws aggregated cells (hex bins or grid). */
function aggregatedViz(l?: RenderedLayer): boolean {
  return l?.viz?.type === "hexbin" || l?.viz?.type === "grid";
}

/** True when a layer's cells aggregate by plain count (value ≡ count). */
function countAggregated(l?: RenderedLayer): boolean {
  const viz = l?.viz;
  return (
    (viz?.type === "hexbin" || viz?.type === "grid") &&
    viz.aggregate.fn === "count"
  );
}

/** A cell's tooltip/pop-up numbers read exactly like its label and the
 * legend — compact, no floating-point noise. */
function compactNumbers(entries: [string, unknown][]): [string, unknown][] {
  return entries.map(([k, v]) =>
    typeof v === "number" ? [k, formatCompact(v)] : [k, v],
  );
}

/** Keep a pop-up anchor on screen so its card stays reachable on small
 * viewports. */
export function clampToView(
  instance: maplibregl.Map,
  x: number,
  y: number,
): [number, number] {
  const el = instance.getContainer();
  return [
    Math.min(Math.max(x, 90), Math.max(el.clientWidth - 90, 90)),
    Math.min(Math.max(y, 16), Math.max(el.clientHeight - 16, 16)),
  ];
}

export interface PointerContext {
  instance: maplibregl.Map;
  interactive: boolean;
  isDragging: () => boolean;
  pinnedRef: MutableRefObject<PinnedPopup | null>;
  layersRef: MutableRefObject<RenderedLayer[]>;
  markScaleRef: MutableRefObject<number>;
  onFeaturePickRef: MutableRefObject<FeaturePickHandler | undefined>;
  setHover: (hover: HoverInfo | null) => void;
  setPinned: (pinned: PinnedPopup | null) => void;
}

export function pointerHandlers(ctx: PointerContext): {
  onHover: (info: PickingInfo) => void;
  onClick: (info: PickingInfo) => void;
} {
  const {
    instance,
    interactive,
    isDragging,
    pinnedRef,
    layersRef,
    markScaleRef,
    onFeaturePickRef,
    setHover,
    setPinned,
  } = ctx;

  const onHover = (info: PickingInfo) => {
    const { object, x, y } = info;
    const layerId = info.layer?.id;
    // Before the pinned-popup early return — the pinned feature is
    // still clickable, so it keeps the pointer.
    instance.getCanvas().style.cursor =
      interactive && object && !isDragging() ? "pointer" : "";
    if (object && interactive) {
      // The pinned pop-up already says everything about its feature —
      // no tooltip shadowing it.
      const p = pinnedRef.current;
      if (p && layerId === p.layerId && info.index === p.index) {
        setHover(null);
        return;
      }
      const props =
        (object as { properties?: Record<string, unknown> }).properties ?? {};
      // Tiled layers pick from namespaced sub-layers (`<id>:mvt-…`);
      // match the owner by prefix. deck adds a `layerName` property to
      // parsed MVT features — metadata, not the user's data.
      const tiled = !!layerId?.includes(":mvt");
      const owner = pickOwner(layersRef.current, layerId);
      let entries = fieldEntries(
        props,
        owner?.tooltip ?? null,
        tiled,
        countAggregated(owner),
      );
      if (aggregatedViz(owner)) entries = compactNumbers(entries);
      if (entries.length === 0) {
        setHover(null);
        return;
      }
      setHover({ x, y, entries });
    } else {
      setHover(null);
    }
  };

  const onClick = (info: PickingInfo) => {
    if (!interactive) return;
    const object = info.object as
      | { properties?: Record<string, unknown> }
      | undefined;
    // A click on empty map dismisses; on a feature, pins — clicking
    // another feature simply moves the card.
    if (!object) {
      setPinned(null);
      return;
    }
    // **Select mode eats the click first**: the armed picker takes the
    // feature's owning layer before cluster zoom and before popup
    // handling — a feature with no displayable fields still has an
    // owner, and discarding it after ownership was found was the seam
    // the plan named. The pick carries the feature's stable identity
    // too, for the draw select tool.
    {
      const pickCb = onFeaturePickRef.current;
      if (pickCb) {
        const picked = pickOwner(layersRef.current, info.layer?.id);
        if (picked) {
          const props = object.properties ?? {};
          const featureId =
            typeof props.feature_id === "string" ? props.feature_id : null;
          const kind = typeof props.kind === "string" ? props.kind : null;
          if (pickCb(picked.id, { featureId, kind })) {
            setHover(null);
            return;
          }
        }
      }
    }
    // A cluster bubble zooms toward where it breaks apart; its
    // unclustered leaves pin pop-ups like any point.
    const bubble = object as {
      clusterId?: number | null;
      expansionZoom?: number | null;
      position?: [number, number];
    };
    if (bubble.clusterId != null && bubble.position) {
      setHover(null);
      setPinned(null);
      // The expansion zoom is LOGICAL (the cluster index's frame); the
      // camera speaks visual zoom, so the space's compensation goes
      // back on. Identity at markScale 1.
      instance.easeTo({
        center: bubble.position,
        zoom:
          (bubble.expansionZoom != null
            ? bubble.expansionZoom + Math.log2(markScaleRef.current)
            : instance.getZoom() + 2) + 0.2,
        duration: 480,
      });
      return;
    }
    const layerId = info.layer?.id;
    const tiled = !!layerId?.includes(":mvt");
    const owner = pickOwner(layersRef.current, layerId);
    let entries = fieldEntries(
      object.properties ?? {},
      owner?.popup ?? null,
      tiled,
      countAggregated(owner),
    );
    if (aggregatedViz(owner)) entries = compactNumbers(entries);
    const coord = info.coordinate as [number, number] | undefined;
    if (entries.length === 0 || !coord) {
      setPinned(null);
      return;
    }
    setHover(null);
    const [x, y] = clampToView(instance, info.x, info.y);
    setPinned({
      lng: coord[0],
      lat: coord[1],
      x,
      y,
      layerId: layerId ?? "",
      index: info.index,
      entries,
    });
  };

  return { onHover, onClick };
}

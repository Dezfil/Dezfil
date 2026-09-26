import type { Layer as DeckLayer } from "@deck.gl/core";
import { MVTLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer } from "@deck.gl/layers";

import {
  deckLayerProps,
  deckUpdateTriggers,
  extrusionProps,
  extrusionScale,
} from "@/lib/style/deck-style";
import type { LayerStyle } from "@/lib/style/style";
import type { LayerViz } from "@/lib/viz";
import { mvtRenderSubLayers, type LiveWindowing } from "./text-sublayer";

/**
 * The parser and this checked-in worker are deliberately version-locked.
 * `tiled-layer.test.ts` compares the application asset byte-for-byte with
 * the installed package and checks this value against its package metadata.
 */
export const LOADERS_GL_MVT_VERSION = "4.4.3";
export const MVT_WORKER_URL =
  `/workers/loaders.gl-mvt-worker-${LOADERS_GL_MVT_VERSION}.js`;

export interface TiledLayerDefinition {
  id: string;
  style: LayerStyle;
  viz?: LayerViz;
  tiles?: { url: string; minZoom?: number; maxZoom?: number } | null;
}

export interface TiledLayerRuntime {
  interactive: boolean;
  markScale: number;
  windowing?: LiveWindowing | null;
}

/**
 * Build the shared vector-tile layer used by every MapCanvas host. The MVT
 * loader stays on its worker-only road, but its worker URL is owned by the
 * application instead of loaders.gl's public-CDN fallback.
 */
export function createTiledLayer(
  layer: TiledLayerDefinition,
  { interactive, markScale, windowing = null }: TiledLayerRuntime,
): DeckLayer {
  const tiles = layer.tiles;
  if (!tiles?.url) {
    throw new Error("A tiled layer requires a tile URL");
  }

  const suffix = windowing ? ":windowed" : "";
  const label = layer.style.label;
  const tiledExtrusion = extrusionScale(layer.style, layer.viz);

  return new MVTLayer({
    id: `${layer.id}:mvt${suffix}`,
    data: tiles.url,
    minZoom: tiles.minZoom,
    maxZoom: tiles.maxZoom,
    // MVTLayer's default loader is the worker-only MVTWorkerLoader. Keep
    // worker use explicit while replacing its default unpkg URL locally.
    loadOptions: {
      core: { worker: true },
      mvt: { workerUrl: MVT_WORKER_URL },
    },
    // Parsed (non-binary) mode: picked objects are plain GeoJSON features,
    // so tooltips and data-driven fills match the inline road.
    binary: false,
    pickable: interactive,
    autoHighlight: interactive,
    highlightColor: [95, 227, 171, 90],
    ...deckLayerProps(layer.style, markScale),
    ...(tiledExtrusion ? extrusionProps(tiledExtrusion) : null),
    // TileLayer forwards windowing into its GeoJsonLayer sublayers; the
    // optional label TextLayer composes the same props in text-sublayer.
    ...(windowing?.props ?? {}),
    updateTriggers: {
      ...deckUpdateTriggers(layer.style),
      ...(tiledExtrusion ? { getElevation: [tiledExtrusion] } : null),
      ...(windowing ? { getFilterValue: windowing.trigger } : null),
    },
    // Tiled labels remain exempt from global thinning because each sublayer
    // only sees one tile.
    ...(label && {
      renderSubLayers: mvtRenderSubLayers(
        label,
        (props) =>
          new GeoJsonLayer(
            props as ConstructorParameters<typeof GeoJsonLayer>[0],
          ),
      ),
    }),
  } as ConstructorParameters<typeof MVTLayer>[0]) as unknown as DeckLayer;
}

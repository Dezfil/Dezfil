import { useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { CameraHandle } from "../map/camera-handle";
import { BASEMAPS } from "@/lib/basemap";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import { builderBasemap } from "./builder-basemap";
import { MapPresentation, type LegendEditing } from "./MapPresentation";
import type { LayerRenderData } from "./render-data";
import { mapWidgetEndpoints, useMapPresentation } from "./use-map-presentation";

/**
 * The presentation mounts on what a reader has (the map record, its
 * layers and widgets, the data endpoints) with no authoring part, and the
 * author's legend editing appears only when the host supplies it. The
 * builder renders through the same component with every authoring part.
 */

const layer: Layer = {
  id: "layer-1",
  mapId: "map-1",
  name: "Harbour depths",
  sql: "SELECT 1",
  style: defaultStyle(null),
  visible: true,
  tooltip: null,
  popup: null,
  publishedFields: null,
  inLegend: true,
  viz: POINTS_VIZ,
  filters: [],
  legendTitle: null,
  legendLabels: null,
  legendAttrs: null,
  ordinal: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const map: MapWithLayers = {
  id: "map-1",
  name: "Harbour",
  viewport: { lng: 0, lat: 0, zoom: 2 },
  basemap: null,
  customBasemap: null,
  basemapLayers: null,
  note: null,
  legendCorner: null,
  legendOrder: null,
  timeline: null,
  widgets: [
    {
      id: "widget-1",
      type: "note",
      layerId: null,
      title: "Tide notes",
      field: null,
      agg: "count",
      aggField: null,
      unit: null,
      note: "Soundings at low water.",
      format: null,
      visible: true,
    },
  ],
  widgetsPublished: false,
  publishToken: null,
  publishedAt: null,
  published: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  layers: [layer],
};

function Stage({ legend }: { legend?: LegendEditing }) {
  const renders: Record<string, LayerRenderData> = {};
  const rendersRef = useRef(renders);
  const mapRef = useRef<MapWithLayers | null>(map);
  const cameraRef = useRef<CameraHandle | null>(null);
  const stage = useMapPresentation({
    map,
    renders,
    rendersRef,
    mapRef,
    endpoints: mapWidgetEndpoints(map.id, null),
    cameraRef,
    setFitBounds: () => {},
    fail: () => {},
    clearFailure: () => {},
  });
  return (
    <MapPresentation
      stage={stage}
      map={map}
      basemap={builderBasemap(map, {
        theme: "dark",
        basemapUrl: "https://tiles.test/style.json",
        basemapOverrideUrl: null,
        basemapOverrideAttribution: [],
        basemaps: BASEMAPS,
      })}
      theme="dark"
      stageEdges={{ left: 16, right: 16 }}
      fitBounds={null}
      timeline={null}
      audience="reader"
      legend={legend}
    />
  );
}

describe("MapPresentation", () => {
  it("mounts on a reader's data alone: the map, the legend, the widgets and the credit", () => {
    const html = renderToStaticMarkup(<Stage />);
    expect(html).toContain("data-map-layer");
    expect(html).toContain("data-drag-canvas");
    expect(html).toContain("Harbour depths");
    expect(html).toContain("Tide notes");
    expect(html).toContain("data-map-credit");
    // Nothing to drag: the legend only reads.
    expect(html).not.toContain("data-dragging");
  });

  it("makes the legend draggable only when the author supplies its editing", () => {
    const html = renderToStaticMarkup(
      <Stage
        legend={{
          dragPreview: null,
          onPreview: () => {},
          onDrop: () => {},
          onTextClick: () => {},
          onLabelEdit: () => {},
        }}
      />,
    );
    expect(html).toContain("Harbour depths");
    expect(html).toContain("data-dragging");
  });
});

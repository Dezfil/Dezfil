import { useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BASEMAPS } from "@/lib/basemap";
import type { Corner } from "@/lib/corners";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import type { CameraHandle } from "../map/camera-handle";
import { ReaderStage } from "../reader/MapReader";
import { ScreenDefaultsProvider } from "../screen-defaults";
import { builderBasemap } from "./builder-basemap";
import { MapPresentation } from "./MapPresentation";
import type { LayerRenderData } from "./render-data";
import { mapWidgetEndpoints, useMapPresentation } from "./use-map-presentation";

/**
 * A map storing no legend corner keeps each surface's own fallback whatever
 * the instance's defaults: top left in the read-only map view, bottom left
 * in the builder. The Legend corner default is written into a new map when
 * it is made and never read when a map is drawn, so a page that hands its
 * screen the instance's defaults, a changed corner among them, moves no
 * legend.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/maps/map-1" }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: () => {} }) }));

/** Every default changed by an admin; the corner is neither surface's
 * fallback, so a legend that took it would stand top right. */
const CHANGED = {
  "newMap.basemap": "streets", "newMap.latitude": -33.8688, "newMap.longitude": 151.2093, "newMap.zoom": 9.75,
  "newMap.legendCorner": "top-right", "newLayer.colorCycle": "tab10", "newLayer.pointOpacity": 10,
  "newLayer.lineOpacity": 100, "newLayer.areaOpacity": 33, "newLayer.lineWidth": 0.5, "newLayer.pointRadius": 12.5,
  "canvas.opens": "framed", "canvas.minimap": "never", "canvas.resultsBand": "open",
  "sqlConsole.textSize": "16", "sqlConsole.lineWrap": true, "imageExport.width": "2560", "imageExport.shape": "1:1",
} as const satisfies InstanceDefaults;

const layer: Layer = {
  id: "l-stations", mapId: "map-1", name: "Stations", sql: "SELECT * FROM stations", style: defaultStyle(null),
  visible: true, tooltip: null, popup: null, publishedFields: null, inLegend: true, viz: POINTS_VIZ, filters: [],
  legendTitle: null, legendLabels: null, legendAttrs: null, ordinal: 0,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
/** A map made before any default existed: no basemap, no legend corner. */
const map: MapWithLayers = {
  id: "map-1", name: "Station catchments", viewport: { lng: 13.4, lat: 52.5, zoom: 10 }, basemap: null,
  customBasemap: null, basemapLayers: null, note: null, legendCorner: null, legendOrder: null, timeline: null,
  widgets: [], widgetsPublished: false, publishToken: null, publishedAt: null, published: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", layers: [layer],
};
const renders = { "l-stations": { layerId: "l-stations", ok: true, geojson: { type: "FeatureCollection", features: [] } } } as unknown as Record<string, LayerRenderData>;
const basemapProps = { basemapUrl: "https://tiles.test/style.json", basemapOverrideUrl: null, basemapOverrideAttribution: [], basemaps: BASEMAPS };

/** The presentation as the builder mounts it: no fallback corner of its
 * own, the author's legend editing, the author's audience. */
function BuilderStage() {
  const rendersRef = useRef(renders);
  const mapRef = useRef<MapWithLayers | null>(map);
  const cameraRef = useRef<CameraHandle | null>(null);
  const stage = useMapPresentation({
    map, renders, rendersRef, mapRef, endpoints: mapWidgetEndpoints(map.id, null), cameraRef,
    setFitBounds: () => {}, fail: () => {}, clearFailure: () => {},
  });
  return (
    <MapPresentation stage={stage} map={map} basemap={builderBasemap(map, { theme: "light", ...basemapProps })} theme="light"
      stageEdges={{ left: 16, right: 16 }} fitBounds={null} timeline={null} audience="author"
      legend={{ dragPreview: null, onPreview: () => {}, onDrop: () => {}, onTextClick: () => {}, onLabelEdit: () => {} }} />
  );
}

const reader = () => <ReaderStage mapId="map-1" map={map} projectId={null} renders={renders} {...basemapProps} />;

/** Which corners hold the legend: each corner's markup runs from its
 * marker to the next corner's. */
function legendCorners(html: string): Corner[] {
  const marks = [...html.matchAll(/data-corner="([a-z-]+)"/g)];
  return marks
    .filter((mark, i) => html.slice(mark.index, marks[i + 1]?.index).includes("Stations"))
    .map((mark) => mark[1] as Corner);
}

describe("the legend of a map storing no corner", () => {
  it("stands top left in the read-only map view under a page handing a changed corner", () => {
    expect(legendCorners(renderToStaticMarkup(reader()))).toEqual(["top-left"]);
    expect(legendCorners(renderToStaticMarkup(<ScreenDefaultsProvider defaults={CHANGED}>{reader()}</ScreenDefaultsProvider>)))
      .toEqual(["top-left"]);
  });

  it("stands bottom left in the builder under a page handing a changed corner", () => {
    expect(legendCorners(renderToStaticMarkup(<BuilderStage />))).toEqual(["bottom-left"]);
    expect(legendCorners(renderToStaticMarkup(<ScreenDefaultsProvider defaults={CHANGED}><BuilderStage /></ScreenDefaultsProvider>)))
      .toEqual(["bottom-left"]);
  });
});

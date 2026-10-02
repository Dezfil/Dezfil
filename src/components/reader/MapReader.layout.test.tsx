import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Corner } from "@/lib/corners";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { BASEMAPS } from "@/lib/basemap";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import type { LayerRenderData } from "../builder/render-data";
import { ReaderStage } from "./MapReader";

/**
 * Where the reader draws the legend, through the builder's own
 * presentation: top left, as the reader's reference lays a Viewer's map out
 * (the legend top left, the widgets and the control stack top right),
 * unless the author placed it in a corner of their own. A layer the reader
 * cannot draw says so on the same top-left line, above the legend rather
 * than over it.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/maps/map-1" }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: () => {} }) }));

const layer = (id: string, name: string): Layer => ({
  id, mapId: "map-1", name, sql: "SELECT * FROM roads", style: defaultStyle(null), visible: true, tooltip: null,
  popup: null, publishedFields: null, inLegend: true, viz: POINTS_VIZ, filters: [], legendTitle: null,
  legendLabels: null, legendAttrs: null, ordinal: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const map = (legendCorner: Corner | null, layers = [layer("l-stations", "Stations")]): MapWithLayers => ({
  id: "map-1", name: "Station catchments", viewport: { lng: 13.4, lat: 52.5, zoom: 10 }, basemap: null,
  customBasemap: null, basemapLayers: null, note: null, legendCorner, legendOrder: null, timeline: null,
  widgets: [], widgetsPublished: false, publishToken: null, publishedAt: null, published: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", layers,
});
const drawn = { layerId: "l-stations", ok: true, geojson: { type: "FeatureCollection", features: [] } } as unknown as LayerRenderData;
const refused: LayerRenderData = { layerId: "l-roads", ok: false, error: { code: "sql_error", message: 'The dataset "roads" is not available to you.' } };

const render = (m: MapWithLayers, renders: Record<string, LayerRenderData>) => renderToStaticMarkup(
  <ReaderStage mapId="map-1" map={m} projectId={null} renders={renders}
    basemapUrl="https://tiles.test/style.json" basemapOverrideUrl={null} basemapOverrideAttribution={[]} basemaps={BASEMAPS} />,
);
/** One corner's markup: from its marker to the next corner's. */
const corner = (html: string, which: Corner) => {
  const at = html.indexOf(`data-corner="${which}"`);
  if (at < 0) return null;
  const next = html.indexOf('data-corner="', at + 1);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("the reader's legend", () => {
  it("stands top left on a map whose author left the legend where it starts", () => {
    const html = render(map(null), { "l-stations": drawn });
    expect(corner(html, "top-left")).toContain("Stations");
    expect(corner(html, "bottom-left")).toBeNull();
  });

  it("keeps a corner the author chose", () => {
    const html = render(map("bottom-left"), { "l-stations": drawn });
    expect(corner(html, "bottom-left")).toContain("Stations");
    expect(corner(html, "top-left")).toBeNull();
  });

  it("says which layer it cannot draw on the top-left line, above the legend", () => {
    const html = render(map(null, [layer("l-stations", "Stations"), layer("l-roads", "Roads")]), { "l-stations": drawn, "l-roads": refused });
    const topLeft = corner(html, "top-left")!;
    expect(topLeft).toContain("data-reader-failures");
    expect(topLeft.indexOf("data-reader-failures")).toBeLessThan(topLeft.indexOf("Stations"));
    expect(html.match(/data-reader-failures/g)).toHaveLength(1);
  });

  it("says it on the top-left line too when the author's legend is elsewhere", () => {
    const html = render(map("bottom-left", [layer("l-stations", "Stations"), layer("l-roads", "Roads")]), { "l-stations": drawn, "l-roads": refused });
    expect(corner(html, "top-left")).toContain("data-reader-failures");
    expect(corner(html, "top-left")).not.toContain("Stations");
    expect(corner(html, "bottom-left")).toContain("Stations");
  });
});

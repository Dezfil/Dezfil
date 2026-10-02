import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { BASEMAPS } from "@/lib/basemap";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import type { LayerRenderData } from "../builder/render-data";
import { loadReader, ReaderStage } from "./MapReader";

/**
 * A Viewer's map: the reader presentation inside the workspace shell. The
 * map, its legend and widgets, zoom, north and fit; nothing that edits, no
 * inspector, no assistant, no publishing chrome. Its reads are reads: the
 * map and each layer's render, never a write, and the presentation is
 * handed no authoring part, so the camera, a thumbnail or the legend can
 * never be persisted from here. A layer it cannot draw says so with the
 * shipped failure note.
 */

const presented = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("../builder/MapPresentation", () => ({
  MapPresentation: (props: Record<string, unknown>) => {
    presented.props = props;
    return (
      <div data-presentation>
        {props.overlay as React.ReactNode}
        {props.controls as React.ReactNode}
      </div>
    );
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/maps/map-1" }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: () => {} }) }));

const layer = (id: string, name: string): Layer => ({
  id, mapId: "map-1", name, sql: "SELECT * FROM roads", style: defaultStyle(null), visible: true, tooltip: null,
  popup: null, publishedFields: null, inLegend: true, viz: POINTS_VIZ, filters: [], legendTitle: null,
  legendLabels: null, legendAttrs: null, ordinal: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const map: MapWithLayers = {
  id: "map-1", name: "Station catchments", viewport: { lng: 13.4, lat: 52.5, zoom: 10 }, basemap: null,
  customBasemap: null, basemapLayers: null, note: null, legendCorner: null, legendOrder: null, timeline: null,
  widgets: [], widgetsPublished: false, publishToken: null, publishedAt: null, published: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  layers: [layer("l-stations", "Stations"), layer("l-roads", "Roads")],
};
const renders: Record<string, LayerRenderData> = {
  "l-stations": { layerId: "l-stations", ok: true, geojson: { type: "FeatureCollection", features: [] } } as unknown as LayerRenderData,
  "l-roads": { layerId: "l-roads", ok: false, error: { code: "sql_error", message: 'The dataset "roads" is not available to you.' } },
};

describe("the Viewer's reader", () => {
  it("reads the map and each layer's render and writes nothing", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/maps/map-1") return Response.json({ ...map, projectId: "berlin" });
      const id = url.split("/")[3];
      return Response.json(renders[id]);
    });
    const loaded = await loadReader("map-1", fetcher as typeof fetch);
    expect(loaded.map.name).toBe("Station catchments");
    expect(loaded.projectId).toBe("berlin");
    expect(Object.keys(loaded.renders).sort()).toEqual(["l-roads", "l-stations"]);
    expect(calls.map((c) => c.url).sort()).toEqual(["/api/layers/l-roads/render", "/api/layers/l-stations/render", "/api/maps/map-1"]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("presents the map as a reader would see it, with no authoring part at all", () => {
    renderToStaticMarkup(
      <ReaderStage mapId="map-1" map={map} projectId="berlin" renders={renders}
        basemapUrl="https://tiles.test/style.json" basemapOverrideUrl={null} basemapOverrideAttribution={[]} basemaps={BASEMAPS} />,
    );
    const props = presented.props!;
    expect(props.audience).toBe("reader");
    // The legend's editing, the widget cards' actions and the canvas's
    // authoring callbacks (camera persistence, thumbnail capture, drawing)
    // are never handed over.
    expect(props.legend).toBeUndefined();
    expect(props.widgetActions).toBeUndefined();
    expect(props.canvas).toBeUndefined();
  });

  it("keeps zoom, north and fit, and nothing that edits", () => {
    const html = renderToStaticMarkup(
      <ReaderStage mapId="map-1" map={map} projectId={null} renders={renders}
        basemapUrl="https://tiles.test/style.json" basemapOverrideUrl={null} basemapOverrideAttribution={[]} basemaps={BASEMAPS} />,
    );
    for (const kept of ["Zoom in", "Zoom out", "Fit to data"]) expect(html).toContain(kept);
    for (const gone of ["Draw", "Fullscreen map", "data-builder-pane", "Add layer", "Publish", "data-assistant-door", "Undo"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("says which layer it cannot draw, with the name as written and that it is not available to you", () => {
    const html = renderToStaticMarkup(
      <ReaderStage mapId="map-1" map={map} projectId={null} renders={renders}
        basemapUrl="https://tiles.test/style.json" basemapOverrideUrl={null} basemapOverrideAttribution={[]} basemaps={BASEMAPS} />,
    );
    expect(html).toContain("data-reader-failures");
    expect(html).toContain("Roads");
    expect(html).toContain("The dataset &quot;roads&quot; is not available to you.");
    expect(html).not.toContain("Technical detail");
  });

  it("stands the control stack top right, as the published viewer's corners in its reference draw it", () => {
    const html = renderToStaticMarkup(
      <ReaderStage mapId="map-1" map={map} projectId={null} renders={renders}
        basemapUrl="https://tiles.test/style.json" basemapOverrideUrl={null} basemapOverrideAttribution={[]} basemaps={BASEMAPS} />,
    );
    expect(html).toMatch(/data-reader-stack="top-right"[^>]*>[\s\S]*Zoom in/);
  });
});

/** The reader's own placement rules, read from its stylesheet: the stage
 * starts where the inspector would, the stack holds the right edge with the
 * widgets and a right legend clear of it, and the left corner no longer
 * clears a stack that is not there. */
describe("the reader's layout", () => {
  const css = readFileSync(new URL("./MapReader.module.css", import.meta.url), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(selector);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("anchors the stack on the right edge", () => {
    const stack = rule(".stack {");
    expect(stack).toMatch(/right:\s*16px/);
    expect(stack).not.toMatch(/\bleft:/);
  });

  it("moves the right-edge furniture clear of the stack and the left corner back to the edge", () => {
    const body = rule(":global(body[data-map-reader])");
    expect(body).toMatch(/--stage-stack-right:\s*48px/);
    expect(body).toMatch(/--stage-stack-left:\s*0px/);
  });

  it("reads the failure note on the stage's top-left line, where the builder's status line is", () => {
    const failures = rule(".failures {");
    expect(failures).toMatch(/top:\s*16px/);
    expect(failures).toMatch(/left:\s*16px/);
    expect(failures).not.toMatch(/translateX/);
  });
});


import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, BUILT_IN_ATTRIBUTION, type BasemapKey, type BasemapStyle } from "@/lib/basemap";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { PublishedView as ViewData } from "@/lib/publish/publish-service";
import { defaultStyle } from "@/lib/style/defaults";
import { POINTS_VIZ } from "@/lib/viz";
import { builderBasemap } from "../builder/builder-basemap";
import { MapPresentation } from "../builder/MapPresentation";
import type { LayerRenderData } from "../builder/render-data";
import { mapWidgetEndpoints, useMapPresentation } from "../builder/use-map-presentation";
import { buildCompositionMapInputs } from "../builder/export/composition-map-inputs";
import { ExportComposition } from "../builder/export/ExportComposition";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { PublishedView } from "../viewer/PublishedView";
import type { CameraHandle } from "./camera-handle";

/**
 * Every surface that draws a map hands the canvas its labels: their face,
 * the tone of the basemap it asks the canvas to draw, and its own theme,
 * which labels take where that tone is not known or the style cannot load.
 * Inter in the workspace (the builder, the reader and a template view, which
 * all draw through the map presentation) and on both image hosts (the export
 * card and the render route, which serves API image export, card pictures
 * and the assistant's look), Archivo on a published map and its embed.
 */

// The canvas needs WebGL: a stand-in records what each host hands it.
const canvas = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("next/dynamic", () => ({
  default: () => function Canvas(props: Record<string, unknown>) {
    canvas.props = props;
    return null;
  },
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  canvas.props = null;
});

const layer: Layer = {
  id: "layer-1", mapId: "map-1", name: "Harbour depths", sql: "SELECT 1", style: defaultStyle(null), visible: true,
  tooltip: null, popup: null, publishedFields: null, inLegend: true, viz: POINTS_VIZ, filters: [], legendTitle: null,
  legendLabels: null, legendAttrs: null, ordinal: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const CUSTOM = { url: "https://charts.example/harbour/style.json", name: "Harbour chart", attribution: [{ label: "© Fixture Charts" }] };
const SATELLITE: BasemapStyle = { key: "satellite", label: "Satellite", kind: "imagery", url: "/api/basemaps/satellite/style.json",
  attribution: [{ label: "Imagery fixture" }] };
/** What an instance with imagery set up draws. */
const STYLES: BasemapStyle[] = [...BASEMAPS, SATELLITE];
const url = (key: BasemapKey) => STYLES.find((b) => b.key === key)!.url;
const workspaceMap = (basemap: BasemapKey | null, custom = false): MapWithLayers => ({
  id: "map-1", name: "Harbour", viewport: { lng: 0, lat: 0, zoom: 2 }, basemap, customBasemap: custom ? CUSTOM : null, basemapLayers: null,
  note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: false, publishToken: null,
  publishedAt: null, published: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", layers: [layer],
});

interface Deployment { overrideUrl?: string | null; basemaps?: BasemapStyle[] }

/** The workspace's map, as the builder and the reader mount it. */
function Workspace({ map, theme, audience, deployment = {}, onLabelTone }: {
  map: MapWithLayers; theme: "light" | "dark"; audience: "author" | "reader"; deployment?: Deployment;
  onLabelTone?: (tone: "light" | "dark") => void;
}) {
  const renders: Record<string, LayerRenderData> = {};
  const rendersRef = useRef(renders);
  const mapRef = useRef<MapWithLayers | null>(map);
  const cameraRef = useRef<CameraHandle | null>(null);
  const stage = useMapPresentation({
    map, renders, rendersRef, mapRef, endpoints: mapWidgetEndpoints(map.id, null), cameraRef,
    setFitBounds: () => {}, fail: () => {}, clearFailure: () => {},
  });
  return (
    <MapPresentation
      stage={stage}
      map={map}
      basemap={builderBasemap(map, {
        theme, basemapUrl: deployment.overrideUrl ?? BASEMAPS[0].url, basemapOverrideUrl: deployment.overrideUrl ?? null,
        basemapOverrideAttribution: [], basemaps: deployment.basemaps ?? STYLES,
      })}
      theme={theme}
      stageEdges={{ left: 16, right: 16 }}
      fitBounds={null}
      timeline={null}
      audience={audience}
      canvas={onLabelTone ? { onLabelTone } : undefined}
    />
  );
}

type Labels = { face: string; tone: string; theme: string };
function workspaceCanvas(map: MapWithLayers, theme: "light" | "dark", audience: "author" | "reader", deployment?: Deployment) {
  renderToStaticMarkup(<Workspace map={map} theme={theme} audience={audience} deployment={deployment} />);
  return canvas.props!;
}
const workspaceLabels = (...args: Parameters<typeof workspaceCanvas>) => workspaceCanvas(...args).labels as Labels;

/** The image composition, as the export card and the render route mount it,
 * handed the tone of the basemap the host draws. */
function imageCanvas(basemapKey: BasemapKey | null, appearance: "light" | "dark", labelTone: "light" | "dark" = "light") {
  renderToStaticMarkup(
    <ExportComposition
      width={800}
      height={600}
      outputWidth={1600}
      map={buildCompositionMapInputs({
        definitionBasemapLayers: undefined, storedBasemapLayers: null, basemapKey, appearance,
        basemapUrl: "https://tiles.example.test/style.json", basemapKind: "vector", labelTone, fallbackColor: "#e9ecef",
        layers: [], liveFilters: null, camera: { lng: 13.4, lat: 52.5, zoom: 11, pitch: 0, bearing: 0 },
      })}
      legend={{ visible: false, corner: "bottom-left", size: "s" }}
      legendLayers={[]}
      widgets={[]}
      values={null}
      valuesState={{ status: "current", error: null }}
      selections={[]}
      title={null}
      attribution={BUILT_IN_ATTRIBUTION}
    />,
  );
  return canvas.props!;
}

/** A published view on `key` (null = Auto), as the server assembles it. */
function viewOn(key: BasemapKey | null, theme: "light" | "dark" = "dark", opts: { custom?: boolean; pinned?: boolean } = {}): ViewData {
  const custom = opts.custom ? CUSTOM : null;
  return {
    name: "Harbour", viewport: { lng: 0, lat: 40, zoom: 1.3, pitch: 0, bearing: 0 }, theme,
    basemapUrl: custom ? custom.url : key ? url(key) : url(theme),
    basemapForTheme: key === null && !custom && !opts.pinned ? { light: url("light"), dark: url("dark") } : null,
    basemapKey: key, customBasemap: custom, basemapPinned: opts.pinned ?? false,
    basemapKind: key === "satellite" && !custom ? "imagery" : "vector",
    basemapAttribution: key === "satellite" ? SATELLITE.attribution : BUILT_IN_ATTRIBUTION,
    basemapLayers: null, note: null, legendCorner: null, legendOrder: null, timeline: null, layers: [], widgets: [],
    viewerControls: { tilt: true, fit: true, coords: true, theme: true, basemap: true },
  } as unknown as ViewData;
}

/** The published reader over `view`, or its embed. */
async function published(view: ViewData, opts: { embedded?: boolean; basemaps?: BasemapStyle[] } = {}) {
  const host = installDomHost();
  Object.assign(host.window, { setInterval, clearInterval, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const page = host.document.createElement("div");
  page.setAttribute("data-published-view", ""); page.setAttribute("data-view-theme", view.theme ?? "dark");
  host.document.body.appendChild(page);
  const root = createRoot(page as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const flush = (work: () => void) => act(async () => { work(); await w.settle(); });
  await flush(() => root.render(
    <PublishedView token="tok" basemapUrl={url("dark")} basemaps={opts.basemaps ?? STYLES} embedded={opts.embedded} />,
  ));
  await flush(() => w.pending("GET", "/api/published/tok")[0].ok(view));
  const button = (test: (button: HostElement) => boolean) => host.document.querySelectorAll("button").find(test)!;
  return {
    canvas: () => canvas.props!,
    labels: () => canvas.props!.labels as Labels,
    toggleTheme: () => flush(() => button((b) => /^Switch to (light|dark) theme$/.test(b.getAttribute("aria-label") ?? "")).click()),
    pick: async (label: string) => {
      await flush(() => button((b) => b.getAttribute("aria-label") === "Basemap").click());
      await flush(() => button((b) => b.textContent === label).click());
    },
  };
}

describe("the face each surface hands its labels", () => {
  it("is Inter in the builder, the workspace reader and a template view", () => {
    for (const audience of ["author", "reader"] as const) {
      expect(workspaceLabels(workspaceMap(null), "light", audience).face, audience).toBe("inter");
    }
  });

  it("is Inter in an image, on the card's preview and the render route alike", () => {
    expect((imageCanvas(null, "light").labels as Labels).face).toBe("inter");
  });

  it("is Archivo on a published map", async () => {
    expect((await published(viewOn("dark"))).labels().face).toBe("archivo");
  });

  it("is Archivo on a published map's embed", async () => {
    expect((await published(viewOn("dark"), { embedded: true })).labels().face).toBe("archivo");
  });
});

describe("the tone the workspace hands its labels", () => {
  it("is the basemap's own on Light, Streets, Dark and Satellite imagery, whatever the person's theme", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const audience of ["author", "reader"] as const) {
        const tone = (key: BasemapKey) => workspaceLabels(workspaceMap(key), theme, audience).tone;
        expect([tone("light"), tone("streets"), tone("dark"), tone("satellite")], `${audience} ${theme}`)
          .toEqual(["light", "light", "dark", "dark"]);
      }
    }
  });

  it("is the person's theme on Auto, on a custom style and on the deployment's own style, with that theme handed beside it", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(workspaceLabels(workspaceMap(null), theme, "author")).toEqual({ face: "inter", tone: theme, theme });
      expect(workspaceLabels(workspaceMap("dark", true), theme, "author").tone).toBe(theme);
      expect(workspaceLabels(workspaceMap(null), theme, "author", { overrideUrl: "https://own.example/style.json" }).tone).toBe(theme);
    }
  });

  it("is the replacement's on Satellite the instance cannot draw: the dark default, or its own style on the theme", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(workspaceLabels(workspaceMap("satellite"), theme, "reader", { basemaps: BASEMAPS }).tone).toBe("dark");
      expect(workspaceLabels(workspaceMap("satellite"), theme, "reader", {
        basemaps: BASEMAPS, overrideUrl: "https://own.example/style.json",
      }).tone).toBe(theme);
    }
  });

  it("hands the canvas the builder's channel for the tone it actually drew", () => {
    const onLabelTone = () => {};
    renderToStaticMarkup(<Workspace map={workspaceMap(null)} theme="light" audience="author" onLabelTone={onLabelTone} />);
    expect(canvas.props!.onLabelTone).toBe(onLabelTone);
  });
});

describe("the tone an image hands its labels", () => {
  it("is the tone of the basemap its host draws, with the image's appearance for the plain background", () => {
    expect(imageCanvas("dark", "light", "dark").labels).toEqual({ face: "inter", tone: "dark", theme: "light" });
    expect(imageCanvas(null, "dark", "dark").labels).toEqual({ face: "inter", tone: "dark", theme: "dark" });
  });
});

describe("the tone a published map hands its labels", () => {
  it("is the basemap's own: dark on Satellite imagery under the reader's light theme", async () => {
    const reader = await published(viewOn("satellite", "light"));
    expect(reader.labels()).toEqual({ face: "archivo", tone: "dark", theme: "light" });
  });

  it("follows a reader's pick over the saved basemap, at once", async () => {
    const reader = await published(viewOn("dark", "dark"));
    expect(reader.labels().tone).toBe("dark");
    await reader.pick("Streets");
    expect(reader.labels()).toEqual({ face: "archivo", tone: "light", theme: "dark" });
  });

  it("follows the reader's theme switch on Auto, at once", async () => {
    const reader = await published(viewOn(null, "dark"));
    expect(reader.labels()).toEqual({ face: "archivo", tone: "dark", theme: "dark" });
    await reader.toggleTheme();
    expect(reader.labels()).toEqual({ face: "archivo", tone: "light", theme: "light" });
  });

  it("takes the reader's theme on the map's own custom style", async () => {
    const reader = await published(viewOn("dark", "light", { custom: true }));
    expect(reader.labels().tone).toBe("light");
  });

  it("takes the reader's theme on the deployment's own style pinning Auto", async () => {
    const reader = await published(viewOn(null, "light", { pinned: true }));
    expect(reader.labels().tone).toBe("light");
  });

  it("takes the dark default's tone on Satellite this instance cannot draw", async () => {
    const reader = await published(viewOn("satellite", "light"), { basemaps: BASEMAPS });
    expect(reader.labels().tone).toBe("dark");
  });
});

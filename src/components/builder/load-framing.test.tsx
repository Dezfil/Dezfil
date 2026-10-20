import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bounds } from "@/lib/geo-bounds";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { HostElement, installDomHost } from "../testing/dom-host";
import { MapOpeningProvider } from "../map-opening";
import { loadFrames } from "./load-framing";
import type { LayerRenderData } from "./render-data";
import { useBuilderMutations, useBuilderReload } from "./use-builder-mutations";

/**
 * A map opens at its saved view, which is what its card picture shows. The
 * builder frames its data on opening only when the page says the map has
 * no view of its own yet, and afterwards only when a load brings a layer it
 * did not have (an added layer comes into view); any other reload leaves
 * the camera alone.
 */

describe("which load frames the data", () => {
  it("frames the first load only when the page asks", () => {
    expect(loadFrames(null, ["a"], false)).toBe(false);
    expect(loadFrames(null, ["a"], true)).toBe(true);
  });
  it("frames a later load only when it brings a new layer", () => {
    const seen = new Set(["a", "b"]);
    expect(loadFrames(seen, ["a", "b"], true)).toBe(false);
    expect(loadFrames(seen, ["b"], true)).toBe(false);
    expect(loadFrames(seen, ["a", "b", "c"], false)).toBe(true);
    expect(loadFrames(seen, ["c"], false)).toBe(true);
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Each layer draws two points one degree apart, its own degree east. */
const drawn = (ids: readonly string[]) => Object.fromEntries(ids.map((id, i) => [id, {
  layerId: id, ok: true, geojson: { type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [10 + i, 50] } },
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [11 + i, 51] } },
  ] },
}])) as unknown as Record<string, LayerRenderData>;

async function openBuilder(framed: boolean | null, layers: string[]) {
  const host = installDomHost();
  vi.stubGlobal("HTMLElement", HostElement);
  const server = { layers };
  const body = () => ({ id: "m", name: "Map", viewport: { lng: 13.4, lat: 52.5, zoom: 10, pitch: 0, bearing: 0 },
    layers: server.layers.map(id => ({ id, mapId: "m", name: id, visible: true })), widgets: [], editRevision: "r" }) as unknown as MapWithLayers;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/maps/m" ? Response.json(body())
    : Response.json({ canUndo: false, canRedo: false, editRevision: "r" })));
  const fits: Bounds[] = [];
  let reload!: () => void;
  // Stable across renders, as the builder's own are: the load effect
  // depends on them.
  const replaceRenders = async (ids: readonly string[]) => drawn(ids);
  const setFitBounds = (bounds: Bounds | null | ((previous: Bounds | null) => Bounds | null)) => {
    if (bounds && typeof bounds !== "function") fits.push(bounds);
  };
  const setSelectedId = () => {}, setMapProjectId = () => {}, refreshLayer = async () => {};
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(null);
    const rendersRef = useRef<Record<string, LayerRenderData>>({});
    const importFocusRef = useRef({ active: false });
    const mutations = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, replaceRenders, setSelectedId, refreshLayer });
    reload = mutations.reload;
    useBuilderReload({ mapId: "m", mutations, importFocusRef, setMap, setMapProjectId, replaceRenders, setFitBounds });
    return null;
  }
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => root.render(framed === null ? <Builder /> : <MapOpeningProvider framed={framed}><Builder /></MapOpeningProvider>));
  await settle();
  return { fits, server, reload: async () => { act(() => reload()); await settle(); } };
}

describe("the builder's loads", () => {
  it.each([["no word from the page", null], ["the page saying it has one", false]] as const)("opens a map with data at its saved view, with %s", async (_, framed) => {
    expect((await openBuilder(framed, ["a"])).fits).toEqual([]);
  });

  it("frames the data on opening when the map has no view of its own", async () => {
    expect((await openBuilder(true, ["a", "b"])).fits).toEqual([[[10, 50], [12, 51]]]);
  });

  it("leaves the camera on a reload that adds nothing, and frames one that brings a layer", async () => {
    const builder = await openBuilder(false, ["a"]);
    await builder.reload();
    builder.server.layers = [];
    await builder.reload();
    expect(builder.fits).toEqual([]);
    builder.server.layers = ["a", "b"];
    await builder.reload();
    expect(builder.fits).toEqual([[[10, 50], [12, 51]]]);
  });
});

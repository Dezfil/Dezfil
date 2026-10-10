import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BASEMAPS, BUILT_IN_ATTRIBUTION, type LibraryStyleOffer } from "@/lib/basemap";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { CameraHandle } from "../map/camera-handle";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { BasemapTab } from "./BasemapTab";
import { builderBasemap } from "./builder-basemap";
import { MapPresentation } from "./MapPresentation";
import { mapWidgetEndpoints, useMapPresentation } from "./use-map-presentation";
import { useBuilderMutations } from "./use-builder-mutations";

/**
 * Taking a style the basemap library offers, as the builder does it: the
 * picker's card goes through the builder's own save lane, and the map's
 * credit is drawn by the builder's own presentation from the map the lane
 * holds. The server copies the style's name, address and credit onto the
 * map; from the click on, the builder holds that copy, as a reload would,
 * and never the reference the request names it by. An undo and a redo of
 * the take land the server's own answer and draw its credit too. The copy
 * is the library's whatever the map held at the take's turn: an earlier
 * write that failed unlanded never lends it its credit.
 */

// The canvas needs WebGL and the status pill measures its layout; the
// credit, the picker and the lane stay real.
vi.mock("next/dynamic", () => ({ default: () => function Canvas() { return null; } }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));

const HARBOUR: LibraryStyleOffer = {
  id: "style-harbour",
  name: "Harbour chart",
  url: "https://charts.example/harbour/style.json",
  attribution: [{ label: "© Fixture Charts", href: "https://charts.example/terms" }],
};
const COPY = { url: HARBOUR.url, name: HARBOUR.name, attribution: HARBOUR.attribution };
const DEPLOYMENT = {
  theme: "dark" as const,
  basemapUrl: "https://tiles.test/style.json",
  basemapOverrideUrl: null,
  basemapOverrideAttribution: [],
  basemaps: BASEMAPS,
};
const history = (editRevision: string, canUndo: boolean, canRedo: boolean) => ({
  canUndo, canRedo, editRevision,
  undoTarget: { eligible: canUndo, reason: null, steps: [] },
  redoTarget: { eligible: canRedo, reason: null, steps: [] },
});

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const initial = { id: "m", name: "Harbour", viewport: { lng: 0, lat: 0, zoom: 2 }, basemap: null, customBasemap: null, basemapLayers: null,
  note: null, legendCorner: null, legendOrder: null, timeline: null, layers: [], widgets: [], widgetsPublished: false,
  editRevision: "first" } as unknown as MapWithLayers;
const builtIn = BUILT_IN_ATTRIBUTION.map(line => line.label).join("·");

/** The builder's picker and presentation over its own save lane, the
 * library's read answered with the styles it offers (one by default). */
async function mount(start: MapWithLayers = initial, offered: LibraryStyleOffer[] = [HARBOUR]) {
  const host = installDomHost();
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const thrown: unknown[] = [];
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element, { onUncaughtError: error => thrown.push(error) });
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const builder = { editor: null as unknown as ReturnType<typeof useBuilderMutations> };
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(start);
    const rendersRef = useRef({});
    const mapRef = useRef<MapWithLayers | null>(map);
    const cameraRef = useRef<CameraHandle | null>(null);
    const editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} });
    builder.editor = editor;
    const { sequence, serverMapRef } = editor;
    useEffect(() => { sequence.accept(start); serverMapRef.current = start; }, [sequence, serverMapRef]);
    const stage = useMapPresentation({ map: map!, renders: {}, rendersRef, mapRef, endpoints: mapWidgetEndpoints("m", null), cameraRef,
      setFitBounds: () => {}, fail: () => {}, clearFailure: () => {} });
    return <>
      <BasemapTab map={map!} loadedGroups={null} overridden={false} patchMap={editor.patchMap} statusPillVisible onToggleStatusPill={() => {}} />
      <MapPresentation stage={stage} map={map!} basemap={builderBasemap(map!, DEPLOYMENT)} theme="dark" stageEdges={{ left: 16, right: 16 }}
        fitBounds={null} timeline={null} audience="author" />
    </>;
  }
  const flush = (work: () => void) => act(async () => { work(); await w.settle(); });
  await flush(() => root.render(<Builder />));
  await flush(() => w.pending("GET", "/api/config")[0].ok({ basemapStyles: offered, singleMapStyles: true }));
  return {
    w, flush, thrown, builder,
    credit: () => host.document.querySelector("[data-map-credit]")?.textContent ?? null,
    card: (name = HARBOUR.name) => host.document.querySelectorAll("button").find(button => button.textContent.trim() === name)!,
  };
}

it("draws the taken style's credit from the click on, through its save, an undo and a redo", async () => {
  const { w, flush, thrown, builder, credit, card } = await mount();
  expect(credit()).toBe(builtIn);

  // The take: the builder draws the copy before the server answers.
  await flush(() => card().click());
  expect(thrown).toEqual([]);
  expect(credit()).toBe("© Fixture Charts");
  expect(card().getAttribute("data-active")).toBe("true");
  const [take] = w.pending("PATCH", "/api/maps/m");
  expect(take.body).toEqual({ customBasemap: { libraryStyle: HARBOUR.id } });
  await flush(() => take.ok({ ...initial, customBasemap: COPY, editRevision: "taken" }));
  expect(credit()).toBe("© Fixture Charts");
  await flush(() => w.pending("GET", "/api/maps/m/history")[0].ok(history("taken", true, false)));

  // An undo lands the server's map without the copy; a redo, with it.
  await flush(() => void builder.editor.applyHistory("undo"));
  await flush(() => w.pending("POST", "/api/maps/m/undo")[0].ok({ ...initial, editRevision: "undone", history: history("undone", false, true) }));
  expect(credit()).toBe(builtIn);
  expect(card().getAttribute("data-active")).toBe("false");
  await flush(() => void builder.editor.applyHistory("redo"));
  await flush(() => w.pending("POST", "/api/maps/m/redo")[0].ok({ ...initial, customBasemap: COPY, editRevision: "redone", history: history("redone", true, false) }));
  expect(credit()).toBe("© Fixture Charts");
  expect(card().getAttribute("data-active")).toBe("true");
  expect(thrown).toEqual([]);
});

it("confirms a take whose answer was lost by the map read back holding the copy", async () => {
  const { w, flush, thrown, builder, credit, card } = await mount();
  await flush(() => card().click());
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: COPY, editRevision: "taken" }));
  // The read is the take landed: the lane accepts it as the new basis.
  expect(builder.editor.sequence.revision).toBe("taken");
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(1);
  expect(credit()).toBe("© Fixture Charts");
  expect(card().getAttribute("data-active")).toBe("true");
  expect(thrown).toEqual([]);
});

it("keeps a take's confirmation exact: a lost answer whose read holds the style under another credit is not taken for it", async () => {
  const { w, flush, thrown, builder, credit, card } = await mount();
  await flush(() => card().click());
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: { ...COPY, attribution: [{ label: "© Another chart" }] }, editRevision: "theirs" }));
  // The take stores the copy the builder drew; a read holding another is no confirmation of it.
  expect(builder.editor.sequence.revision).toBe("first");
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(0);
  expect(credit()).toBe("© Fixture Charts");
  expect(thrown).toEqual([]);
});

/** A style pasted earlier, on the map when the builder opens. */
const EARLIER = { url: "https://tiles.example/earlier/style.json", name: "Old harbour", attribution: [{ label: "© Earlier Tiles" }] };
/** Another style of the same provider, under the same credit. */
const NIGHT: LibraryStyleOffer = { id: "style-harbour-night", name: "Harbour chart, night", url: "https://charts.example/night/style.json",
  attribution: HARBOUR.attribution };

it.each([
  ["holding the taken copy", COPY, "taken", "taken"],
  ["holding the taken address and name under the earlier style's credit, which the take never stores", { ...COPY, attribution: EARLIER.attribution }, "theirs", "first"],
])("draws and confirms a take as the library offers it after another take queued before it failed unlanded: a lost answer's read %s", async (_what, stored, revision, basis) => {
  const { w, flush, thrown, builder, credit, card } = await mount({ ...initial, customBasemap: EARLIER } as MapWithLayers, [HARBOUR, NIGHT]);
  expect(credit()).toBe("© Earlier Tiles");
  // Two takes in a row: the first one's answer is lost and the read proves
  // it never landed.
  await flush(() => card(NIGHT.name).click());
  await flush(() => card().click());
  const [night] = w.pending("PATCH", "/api/maps/m");
  expect(night.body).toEqual({ customBasemap: { libraryStyle: NIGHT.id } });
  await flush(() => night.cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: EARLIER, editRevision: "first" }));
  expect(builder.editor.sequence.revision).toBe("first");
  // The second take is still drawn as the library offers it, never under
  // the earlier style's credit (soft: the confirmation below is judged either way).
  expect.soft(credit()).toBe("© Fixture Charts");

  const [take] = w.pending("PATCH", "/api/maps/m");
  expect(take.body).toEqual({ customBasemap: { libraryStyle: HARBOUR.id } });
  await flush(() => take.cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: stored, editRevision: revision }));
  // Only the map the take stores is the take landed.
  expect(builder.editor.sequence.revision).toBe(basis);
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(basis === "taken" ? 1 : 0);
  expect(thrown).toEqual([]);
});

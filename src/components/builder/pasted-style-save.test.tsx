import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BASEMAPS, BUILT_IN_ATTRIBUTION, SINGLE_MAP_STYLES_OFF, type LibraryStyleOffer } from "@/lib/basemap";
import { EDIT_REVISION_HEADER } from "@/lib/edit-basis";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { STALE_MESSAGE } from "../document-sequence";
import type { CameraHandle } from "../map/camera-handle";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { BasemapTab } from "./BasemapTab";
import { BuilderFailureNotes } from "./BuilderFailureNotes";
import { builderBasemap } from "./builder-basemap";
import { MapPresentation } from "./MapPresentation";
import { mapWidgetEndpoints, useMapPresentation } from "./use-map-presentation";
import { useBuilderMutations } from "./use-builder-mutations";

/**
 * Saving a style address pasted into the Custom door, as the builder does
 * it: the door's check, its "Use this style" (or "Use anyway"), the
 * builder's own save lane and the map's credit drawn by the builder's own
 * presentation from the map the lane holds. The server stores the address,
 * the typed name and a credit: the style's own lines, or its host when the
 * style carries none or was saved unread. From the click on, the builder
 * holds that copy, as a reload would; an undo and a redo land the server's
 * answer, and a lost answer is confirmed by the map read back. The save
 * reads the style again, so the map read back may hold another credit than
 * the check's (the style changed, or a style the check could not read was
 * saved anyway and the save could): it is the save landed where the read
 * holds the same address and name and the rest of the map as it was, and
 * an unknown outcome otherwise. The copy is the one sent whatever the map
 * held at the save's turn: an earlier write that failed unlanded never
 * lends it its name.
 *
 * The basemap's other writes the builder draws before the answer hold what
 * the server stores too: a group shown again is stored as no entry (only
 * hidden groups are kept), so a lost answer to it is confirmed by the read.
 */

// The canvas needs WebGL and the status pill measures its layout; the
// credit, the picker and the lane stay real.
vi.mock("next/dynamic", () => ({ default: () => function Canvas() { return null; } }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));

const URL_PASTED = "https://tiles.example/harbour/style.json";
const CREDIT = [{ label: "© Fixture Tiles", href: "https://tiles.example/terms" }];
/** The credit the save's own read of the style found, past the check. */
const REVISED = [{ label: "© Fixture Tiles and partners", href: "https://tiles.example/terms" }];
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
 * library's read answered with the styles it offers (none by default). */
async function mount(start: MapWithLayers = initial, offered: LibraryStyleOffer[] = []) {
  const host = installDomHost();
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const thrown: unknown[] = [];
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element, { onUncaughtError: error => thrown.push(error) });
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const builder = { editor: null as unknown as ReturnType<typeof useBuilderMutations>, map: null as MapWithLayers | null };
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(start);
    builder.map = map;
    const rendersRef = useRef({});
    const mapRef = useRef<MapWithLayers | null>(map);
    const cameraRef = useRef<CameraHandle | null>(null);
    const editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    builder.editor = editor;
    const { sequence, serverMapRef } = editor;
    useEffect(() => { sequence.accept(start); serverMapRef.current = start; }, [sequence, serverMapRef]);
    const stage = useMapPresentation({ map: map!, renders: {}, rendersRef, mapRef, endpoints: mapWidgetEndpoints("m", null), cameraRef,
      setFitBounds: () => {}, fail: () => {}, clearFailure: () => {} });
    return <>
      <BuilderFailureNotes failures={editor.failures} clearFailure={editor.clearFailure} activeDownloads={[]} downloadFailures={[]} />
      <BasemapTab map={map!} loadedGroups={null} overridden={false} patchMap={editor.patchMap} statusPillVisible onToggleStatusPill={() => {}} />
      <MapPresentation stage={stage} map={map!} basemap={builderBasemap(map!, DEPLOYMENT)} theme="dark" stageEdges={{ left: 16, right: 16 }}
        fitBounds={null} timeline={null} audience="author" />
    </>;
  }
  const flush = (work: () => void) => act(async () => { work(); await w.settle(); });
  await flush(() => root.render(<Builder />));
  await flush(() => w.pending("GET", "/api/config")[0].ok({ basemapStyles: offered, singleMapStyles: true }));
  const button = (text: string) => host.document.querySelectorAll("button").find(b => b.textContent.trim().endsWith(text) || b.getAttribute("aria-label") === text);
  /** Type into an input as React hears it: through its change handler. */
  const type = (selector: string, value: string) => {
    const input = host.document.querySelector(selector)!;
    const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    return flush(() => (input as unknown as Record<string, { onChange: (e: { target: { value: string } }) => void }>)[key].onChange({ target: { value } }));
  };
  /** The Custom door opened, an address and a name typed, and its check answered. */
  const paste = async (name: string, inspection: unknown) => {
    await flush(() => button("Custom…")!.click());
    await type('input[type="url"]', URL_PASTED);
    await type('input[placeholder="Company dark"]', name);
    await flush(() => button("Check")!.click());
    const [check] = w.pending("POST", "/api/basemap/inspect");
    expect(check.body).toEqual({ url: URL_PASTED });
    await flush(() => check.ok(inspection));
  };
  const credit = () => host.document.querySelector("[data-map-credit]")?.textContent ?? null;
  /** Where a lost answer left the builder: the lane's basis, the drawn
   * credit, and the next edit (Auto) answered as the server answers it,
   * refused as stale on any revision but the one the map holds. */
  const afterLoss = async (held: string) => {
    const seen = { revision: builder.editor.sequence.revision, credit: credit() };
    await flush(() => button("Auto")!.click());
    const [next] = w.pending("PATCH", "/api/maps/m");
    await flush(() => next.headers.get(EDIT_REVISION_HEADER) === held
      ? next.ok({ ...initial, editRevision: "auto" })
      : next.refuse(409, "stale_revision", STALE_MESSAGE));
    return { ...seen, next: builder.editor.sequence.stale ? "stale_revision" : "saved" };
  };
  const failure = () => host.document.querySelector('[data-map-error][data-lane="map"]')?.textContent ?? null;
  return { w, flush, thrown, builder, button, paste, credit, failure, afterLoss };
}

it("draws a checked style's credit from the click on, through its save, an undo and a redo", async () => {
  const { w, flush, thrown, builder, button, paste, credit } = await mount();
  expect(credit()).toBe(builtIn);
  await paste("Harbour lights", { verdict: "valid", name: "Harbour", layerCount: 3, sourceCount: 1, attribution: CREDIT });

  // The save: the builder draws the copy the server will store before it answers.
  await flush(() => button("Use this style")!.click());
  expect(thrown).toEqual([]);
  expect(credit()).toBe("© Fixture Tiles");
  expect(builder.map!.customBasemap).toEqual({ url: URL_PASTED, name: "Harbour lights", attribution: CREDIT });
  const [save] = w.pending("PATCH", "/api/maps/m");
  expect(save.body).toEqual({ customBasemap: { url: URL_PASTED, name: "Harbour lights" } });
  const stored = { url: URL_PASTED, name: "Harbour lights", attribution: CREDIT };
  await flush(() => save.ok({ ...initial, customBasemap: stored, editRevision: "pasted" }));
  expect(credit()).toBe("© Fixture Tiles");
  await flush(() => w.pending("GET", "/api/maps/m/history")[0].ok(history("pasted", true, false)));

  // An undo lands the server's map without the style; a redo, with it.
  await flush(() => void builder.editor.applyHistory("undo"));
  await flush(() => w.pending("POST", "/api/maps/m/undo")[0].ok({ ...initial, editRevision: "undone", history: history("undone", false, true) }));
  expect(credit()).toBe(builtIn);
  await flush(() => void builder.editor.applyHistory("redo"));
  await flush(() => w.pending("POST", "/api/maps/m/redo")[0].ok({ ...initial, customBasemap: stored, editRevision: "redone", history: history("redone", true, false) }));
  expect(credit()).toBe("© Fixture Tiles");
  expect(thrown).toEqual([]);
});

it("draws the host as the credit of a style that carries none", async () => {
  const { w, flush, thrown, builder, button, paste, credit } = await mount();
  await paste("", { verdict: "valid", name: null, layerCount: 1, sourceCount: 1, attribution: [] });
  await flush(() => button("Use this style")!.click());
  expect(thrown).toEqual([]);
  expect(credit()).toBe("tiles.example");
  expect(builder.map!.customBasemap).toEqual({ url: URL_PASTED, name: null, attribution: [{ label: "tiles.example" }] });
  expect(w.pending("PATCH", "/api/maps/m")[0].body).toEqual({ customBasemap: { url: URL_PASTED, name: null } });
});

it("confirms a style saved unread, whose answer was lost, by the map read back holding its host as the credit", async () => {
  const { w, flush, thrown, builder, button, paste, credit } = await mount();
  await paste("Harbour lights", { verdict: "unreachable", detail: "HTTP 503." });
  await flush(() => button("Use anyway")!.click());
  expect(thrown).toEqual([]);
  expect(credit()).toBe("tiles.example");
  const [save] = w.pending("PATCH", "/api/maps/m");
  // The server is told to save it unread; it stores the host as the credit.
  expect(save.body).toEqual({ customBasemap: { url: URL_PASTED, name: "Harbour lights", force: true } });
  await flush(() => save.cut());
  const stored = { url: URL_PASTED, name: "Harbour lights", attribution: [{ label: "tiles.example" }] };
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: stored, editRevision: "pasted" }));
  // The read is the save landed: the lane accepts it as the new basis.
  expect(builder.editor.sequence.revision).toBe("pasted");
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(1);
  expect(credit()).toBe("tiles.example");
  expect(thrown).toEqual([]);
});

it("takes the credit the save read when its answer was lost and the style's credit had changed since the check", async () => {
  const { w, flush, thrown, button, paste, afterLoss } = await mount();
  await paste("Harbour lights", { verdict: "valid", name: "Harbour", layerCount: 3, sourceCount: 1, attribution: CREDIT });
  await flush(() => button("Use this style")!.click());
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].cut());
  const stored = { url: URL_PASTED, name: "Harbour lights", attribution: REVISED };
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: stored, editRevision: "pasted" }));
  expect(await afterLoss("pasted")).toEqual({ revision: "pasted", credit: "© Fixture Tiles and partners", next: "saved" });
  expect(thrown).toEqual([]);
});

it("takes the credit the save read when a style the check could not read was saved anyway, the save read it, and the answer was lost", async () => {
  const { w, flush, thrown, button, paste, afterLoss } = await mount();
  await paste("Harbour lights", { verdict: "unreachable", detail: "HTTP 503." });
  await flush(() => button("Use anyway")!.click());
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].cut());
  const stored = { url: URL_PASTED, name: "Harbour lights", attribution: CREDIT };
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: stored, editRevision: "pasted" }));
  expect(await afterLoss("pasted")).toEqual({ revision: "pasted", credit: "© Fixture Tiles", next: "saved" });
  expect(thrown).toEqual([]);
});

it.each([
  ["another name", { customBasemap: { url: URL_PASTED, name: "Someone's harbour", attribution: REVISED } }],
  ["another address", { customBasemap: { url: "https://tiles.example/other/style.json", name: "Harbour lights", attribution: REVISED } }],
  ["another change beside the style", { name: "Renamed", customBasemap: { url: URL_PASTED, name: "Harbour lights", attribution: REVISED } }],
])("takes no map for a lost save's answer whose read holds %s: the outcome stays unknown", async (_what, read) => {
  const { w, flush, thrown, button, paste, afterLoss } = await mount();
  await paste("Harbour lights", { verdict: "valid", name: "Harbour", layerCount: 3, sourceCount: 1, attribution: CREDIT });
  await flush(() => button("Use this style")!.click());
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, ...read, editRevision: "theirs" }));
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(0);
  // Another write's map is never this save's: the next edit meets the server's stale refusal.
  expect(await afterLoss("theirs")).toEqual({ revision: "first", credit: "© Fixture Tiles", next: "stale_revision" });
  expect(thrown).toEqual([]);
});

/** A style pasted earlier, on the map when the builder opens. */
const EARLIER = { url: "https://tiles.example/earlier/style.json", name: "Old harbour", attribution: [{ label: "© Earlier Tiles" }] };
/** A style the library offers, taken by its id. */
const CHART: LibraryStyleOffer = { id: "style-chart", name: "Harbour chart", url: "https://charts.example/harbour/style.json",
  attribution: [{ label: "© Fixture Charts", href: "https://charts.example/terms" }] };

it.each([
  ["holding the pasted style under the name it was sent with", { url: URL_PASTED, name: CHART.name, attribution: CREDIT }, "pasted",
    { revision: "pasted", credit: "© Fixture Tiles", next: "saved" }],
  ["holding it under the earlier style's name, which was never sent", { url: URL_PASTED, name: EARLIER.name, attribution: CREDIT }, "theirs",
    { revision: "first", credit: "© Fixture Tiles", next: "stale_revision" }],
])("draws and confirms a pasted style as sent after a take queued before it failed unlanded: a lost answer's read %s", async (_what, stored, revision, outcome) => {
  const { w, flush, thrown, builder, button, paste, afterLoss } = await mount({ ...initial, customBasemap: EARLIER } as MapWithLayers, [CHART]);
  // A library take, then, while it is in flight, a style pasted under the
  // taken style's name.
  await flush(() => button(CHART.name)!.click());
  await paste(CHART.name, { verdict: "valid", name: "Harbour", layerCount: 3, sourceCount: 1, attribution: CREDIT });
  await flush(() => button("Use this style")!.click());
  const sent = { url: URL_PASTED, name: CHART.name, attribution: CREDIT };
  expect(builder.map!.customBasemap).toEqual(sent);

  // The take's answer is lost and the read proves it never landed.
  const [take] = w.pending("PATCH", "/api/maps/m");
  expect(take.body).toEqual({ customBasemap: { libraryStyle: CHART.id } });
  await flush(() => take.cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: EARLIER, editRevision: "first" }));
  expect(builder.editor.sequence.revision).toBe("first");
  // The pasted style is still drawn as it is sent, never over the earlier
  // style's name (soft: the confirmation below is judged either way).
  expect.soft(builder.map!.customBasemap).toEqual(sent);

  const [save] = w.pending("PATCH", "/api/maps/m");
  expect(save.body).toEqual({ customBasemap: { url: URL_PASTED, name: CHART.name } });
  await flush(() => save.cut());
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, customBasemap: stored, editRevision: revision }));
  // Only the map the save stores is the save landed.
  expect(builder.editor.sequence.revision).toBe(outcome.revision);
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(outcome.next === "saved" ? 1 : 0);
  expect(await afterLoss(revision)).toEqual(outcome);
  expect(thrown).toEqual([]);
});

it("sends a group shown again as the server stores it, and confirms a lost answer by the map read back", async () => {
  const hidden = { ...initial, basemapLayers: { labels: false } } as MapWithLayers;
  const { w, flush, thrown, builder, button } = await mount(hidden);
  await flush(() => button("Show labels")!.click());
  const [shown] = w.pending("PATCH", "/api/maps/m");
  await flush(() => shown.cut());
  // Only hidden groups are stored: with none left, the server keeps null,
  // and the read holding it is the write landed.
  await flush(() => w.pending("GET", "/api/maps/m")[0].ok({ ...initial, editRevision: "shown" }));
  expect(builder.editor.sequence.revision).toBe("shown");
  expect(w.pending("GET", "/api/maps/m/history")).toHaveLength(1);
  expect(shown.body).toEqual({ basemapLayers: null });
  expect(builder.map!.basemapLayers).toBeNull();

  // Hiding one again while another stays hidden is stored as sent.
  await flush(() => w.pending("GET", "/api/maps/m/history")[0].ok(history("shown", true, false)));
  await flush(() => button("Hide roads")!.click());
  await flush(() => button("Hide labels")!.click());
  const [roads] = w.pending("PATCH", "/api/maps/m");
  expect(roads.body).toEqual({ basemapLayers: { roads: false } });
  await flush(() => roads.ok({ ...initial, basemapLayers: { roads: false }, editRevision: "roads" }));
  const [labels] = w.pending("PATCH", "/api/maps/m");
  expect(labels.body).toEqual({ basemapLayers: { roads: false, labels: false } });
  expect(thrown).toEqual([]);
});

it("takes a refused pasted style off the screen: the map shows what the server stores, the failure line stays", async () => {
  const { w, flush, thrown, builder, button, paste, credit, failure } = await mount();
  expect(credit()).toBe(builtIn);
  await paste("Harbour lights", { verdict: "valid", name: "Harbour", layerCount: 3, sourceCount: 1, attribution: CREDIT });
  await flush(() => button("Use this style")!.click());
  expect(credit()).toBe("© Fixture Tiles");
  // Single-map styles were switched off for this instance meanwhile.
  await flush(() => w.pending("PATCH", "/api/maps/m")[0].refuse(403, "basemap_not_offered", SINGLE_MAP_STYLES_OFF));
  expect(builder.editor.sequence.revision).toBe("first");
  expect(builder.map!.customBasemap).toBeNull();
  expect(credit()).toBe(builtIn);
  expect(failure()).toContain(SINGLE_MAP_STYLES_OFF);
  // Nothing of the refused style waits to be drawn again.
  expect(builder.editor.drafts.apply(initial).customBasemap).toBeNull();
  expect(thrown).toEqual([]);
});

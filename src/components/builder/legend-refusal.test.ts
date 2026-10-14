import { afterEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";
import { HookHarness, hookReact } from "../workflow-canvas/hook-harness";
import { wire } from "../workflow-canvas/fetch-wire";
vi.mock("react", () => hookReact);
import { legendItems } from "../map/LegendPanel";
import { useBuilderMutations } from "./use-builder-mutations";
import { useLegendLayers } from "./use-legend-layers";
import { useLegendTab } from "./use-legend-tab";

/**
 * A refused legend edit through the builder's own hooks: the Legend tab's
 * live text, its save through the mutation lane, and the legend the panel
 * draws from them (the panel's own item rule, without a DOM). The map
 * holds one layer whose stored legend title is "Stored title".
 */

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

function setup(legendAttrs: Record<string, string | null> | null = null) {
  const w = wire();
  const stored = { id: "a", name: "Harbours", visible: true, inLegend: true, viz: { type: "points" }, style: defaultStyle("POINT"),
    legendTitle: "Stored title", legendLabels: null, legendAttrs };
  const initial = { id: "m", name: "Map", editRevision: "seen", legendOrder: null, layers: [stored] } as unknown as MapWithLayers & { editRevision: string };
  let map = initial;
  vi.stubGlobal("fetch", vi.fn((...args: Parameters<typeof globalThis.fetch>) => w.fetch(...args)));
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const h = new HookHarness(() => {
    const setMap = (next: MapWithLayers | null | ((current: MapWithLayers | null) => MapWithLayers | null)) => {
      map = (typeof next === "function" ? next(map) : next)! as typeof initial;
    };
    const editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    const tab = useLegendTab({ ...editor, setMap });
    const legend = useLegendLayers({ map, renders: {}, legendLive: editor.legendLive, appearanceDrafts: {} });
    return { ...editor, tab, legend };
  });
  cleanups.push(() => h.unmount());
  h.value.applyMapResponse(initial, false, Infinity);
  h.render();
  /** The title the legend panel draws for the layer. */
  const drawnTitle = () => legendItems(h.render().legend)[0]?.title;
  /** What the Legend tab does as the author types a title and leaves the field. */
  const type = (title: string) => { h.value.onLegendLive("a", { legendTitle: title }); h.render(); };
  const save = (title: string) => { h.value.tab.onTitle("a", title); h.render(); };
  return { h, w, stored, drawnTitle, type, save, map: () => map };
}

it("takes a refused legend title off the drawn legend: the stored title returns, the failure line stays", async () => {
  const c = setup();
  c.type("Refused title");
  c.save("Refused title");
  expect(c.drawnTitle()).toBe("Refused title");
  c.w.pending("PATCH", "/api/layers/a")[0].refuse(400, "invalid_request", "legendTitle is too long.");
  await c.w.settle();
  expect(c.map().layers[0].legendTitle).toBe("Stored title");
  expect(c.drawnTitle()).toBe("Stored title");
  expect(c.h.value.legendLive.a?.legendTitle).toBeUndefined();
  expect(c.h.value.failures["layer:a"]).toBe("legendTitle is too long.");
});

it("keeps a newer title saved behind the refused one drawn until its own answer", async () => {
  const c = setup();
  c.type("Refused title");
  c.save("Refused title");
  c.type("Newer title");
  c.save("Newer title");
  c.w.pending("PATCH", "/api/layers/a")[0].refuse(400, "invalid_request", "legendTitle is too long.");
  await c.w.settle();
  // The newer edit is still in flight: its text stays on the legend.
  expect(c.drawnTitle()).toBe("Newer title");
  const next = c.w.pending("PATCH", "/api/layers/a")[0];
  expect(next.body).toEqual({ legendTitle: "Newer title" });
  next.ok({ ...c.stored, legendTitle: "Newer title", editRevision: "newer" });
  await c.w.settle();
  expect(c.drawnTitle()).toBe("Newer title");
  expect(c.h.value.legendLive.a).toBeUndefined();
});

it("keeps the refused title drawn when the map changed elsewhere, for copying before a reload", async () => {
  const c = setup();
  c.type("Refused title");
  c.save("Refused title");
  c.w.pending("PATCH", "/api/layers/a")[0].refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
  await c.w.settle();
  expect(c.h.value.sequence.stale).toBe(true);
  expect(c.drawnTitle()).toBe("Refused title");
  expect(c.h.value.legendLive.a?.legendTitle).toBe("Refused title");
});

it("takes a refused variable name off the legend while a variable name saved behind it stays, through that save's answer", async () => {
  const c = setup({ fill: "Stored fill" });
  // The Legend tab sends every variable name it holds; the lane keeps only
  // what each save changed, so the radius save carries no fill of its own.
  c.h.value.onLegendLive("a", { legendAttrs: { fill: "Refused fill" } });
  c.h.value.tab.onAttrs("a", { fill: "Refused fill" });
  c.h.render();
  c.h.value.onLegendLive("a", { legendAttrs: { fill: "Refused fill", radius: "Queued radius" } });
  c.h.value.tab.onAttrs("a", { fill: "Refused fill", radius: "Queued radius" });
  c.h.render();
  const attrs = () => legendItems(c.h.render().legend)[0]?.attrs;
  expect(attrs()).toEqual({ fill: "Refused fill", radius: "Queued radius" });
  c.w.pending("PATCH", "/api/layers/a")[0].refuse(400, "invalid_request", "legendAttrs is not valid.");
  await c.w.settle();
  expect(attrs(), "the refused fill name stayed on the legend").toEqual({ fill: "Stored fill", radius: "Queued radius" });
  const next = c.w.pending("PATCH", "/api/layers/a")[0];
  expect(next.body).toEqual({ legendAttrs: { fill: "Stored fill", radius: "Queued radius" } });
  next.ok({ ...c.stored, legendAttrs: { fill: "Stored fill", radius: "Queued radius" }, editRevision: "radius" });
  await c.w.settle();
  expect(attrs()).toEqual({ fill: "Stored fill", radius: "Queued radius" });
  expect(c.h.value.legendLive.a).toBeUndefined();
});

it("keeps a variable name typed since a refused one on the legend, and the stored one where nothing was typed", async () => {
  const c = setup({ fill: "Stored fill" });
  c.h.value.onLegendLive("a", { legendAttrs: { fill: "Refused fill" } });
  c.h.value.tab.onAttrs("a", { fill: "Refused fill" });
  c.h.render();
  // Typed since, not saved yet.
  c.h.value.onLegendLive("a", { legendAttrs: { fill: "Refused fill", radius: "Typed radius" } });
  c.h.render();
  c.w.pending("PATCH", "/api/layers/a")[0].refuse(400, "invalid_request", "legendAttrs is not valid.");
  await c.w.settle();
  expect(legendItems(c.h.render().legend)[0]?.attrs).toEqual({ fill: "Stored fill", radius: "Typed radius" });
  expect(c.h.value.legendLive.a?.legendAttrs).toEqual({ fill: "Stored fill", radius: "Typed radius" });
});

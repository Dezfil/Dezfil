import { afterEach, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "../workflow-canvas/hook-harness";
import { wire, type Wire } from "../workflow-canvas/fetch-wire";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { LayerFilter } from "@/lib/viz";
import type { MapWidget } from "@/lib/widgets";
import type { LayerStyle } from "@/lib/style/style";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerRenderData } from "./render-data";
vi.mock("react", () => hookReact);
import { useLayerRenders } from "./use-layer-renders";
import { useBuilderMutations, useBuilderReload } from "./use-builder-mutations";
import { useWidgetListActions } from "./use-widget-list-actions";
import { useTimeline } from "./use-timeline";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A builder render carries only the fields its layer and map read. Each
// test loads a map whose layer render was built without some field, makes
// the edit that starts reading it through the builder's own path, and
// watches the wire for the layer asking for its render again.

const style = defaultStyle("POINT");
const base = {
  id: "L", mapId: "m", name: "Stations", sql: "SELECT * FROM stations", visible: true,
  filters: [], viz: { type: "points" }, style, tooltip: [], popup: [], publishedFields: null,
} as unknown as Layer;
const mapOf = (layer: Layer, over: Partial<MapWithLayers & { editRevision: string }> = {}): MapWithLayers =>
  ({ id: "m", name: "Map", layers: [layer], widgets: [], timeline: null, widgetsPublished: false, editRevision: "r1", ...over }) as unknown as MapWithLayers;
const history = { canUndo: false, canRedo: false, editRevision: "r1", undoTarget: { eligible: false, reason: null, steps: [] } };
const drawn = (properties: Record<string, unknown>): LayerRenderData => ({
  layerId: "L", ok: true, mode: "inline", featureCount: 1, geometryType: "POINT",
  geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties, geometry: { type: "Point", coordinates: [0, 0] } }] },
});
const tiled: LayerRenderData = {
  layerId: "L", ok: true, mode: "tiled", geometryType: "POINT",
  tiles: { state: "ready", url: "/api/layers/L/tiles/{z}/{x}/{y}?v=1", bounds: [0, 0, 1, 1] },
};
const noop = () => {};
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};
const renderCalls = (w: Wire) => w.pending("GET", "/api/layers/L/render");

function mountBuilder() {
  let map: MapWithLayers | null = null;
  const setMap = (next: MapWithLayers | null | ((current: MapWithLayers | null) => MapWithLayers | null)) => {
    map = typeof next === "function" ? next(map) : next;
  };
  const importFocusRef = { current: { active: false } };
  const h = new HookHarness(() => {
    const renders = useLayerRenders();
    const mutations = useBuilderMutations({
      mapId: "m", map, setMap, rendersRef: renders.rendersRef, replaceRenders: renders.replaceRenders,
      setSelectedId: noop, refreshLayer: renders.refreshLayer,
    });
    useBuilderReload({
      mapId: "m", mutations, importFocusRef, setMap, setMapProjectId: noop,
      replaceRenders: renders.replaceRenders, setFitBounds: noop,
    });
    const widgets = useWidgetListActions({
      map, visibleWidgets: map?.widgets ?? [], setMap, patchMap: mutations.patchMap,
      truthSeqRef: mutations.truthSeqRef, mapFieldEditedAtRef: mutations.mapFieldEditedAtRef,
      setTab: noop, setWidgetFocus: noop,
    });
    const timeline = useTimeline({ map, patchMap: mutations.patchMap, patchLayer: mutations.patchLayer, preview: noop });
    return { renders, mutations, widgets, timeline };
  });
  return h;
}

/** The builder, loaded with `saved` and its layer's first render. */
async function loaded(saved: MapWithLayers, first: LayerRenderData = drawn({})) {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const h = mountBuilder();
  await flush();
  w.pending("GET", "/api/maps/m")[0].ok(saved);
  await flush();
  w.pending("GET", "/api/maps/m/history")[0].ok(history);
  renderCalls(w)[0].ok(first);
  await flush();
  h.render();
  expect(h.value.renders.renders.L).toEqual(first);
  return { w, h };
}

/** A layer edit through the builder's lane, accepted as sent. */
async function editLayer(w: Wire, h: HookHarness<ReturnType<typeof mountBuilder>["value"]>, saved: MapWithLayers, fields: Partial<Layer>, opts: { skipRefresh?: boolean } = {}) {
  void h.value.mutations.patchLayer("L", fields as Record<string, unknown>, opts);
  await flush();
  w.pending("PATCH", "/api/layers/L")[0].ok({ ...saved.layers[0], ...fields, editRevision: "r2" });
  await flush();
  h.render();
}

const categorical = (attribute: string): LayerStyle => ({
  ...style,
  fill: { type: "categorical", attribute, palette: "p", map: [], other: { r: 0, g: 0, b: 0, a: 1 } },
});
const labelled = (attribute: string, priorityField: string | null = null): LayerStyle => ({
  ...style,
  label: { attribute, priorityField, size: 12, color: { r: 0, g: 0, b: 0, a: 1 }, haloWidth: 1, haloColor: { r: 0, g: 0, b: 0, a: 1 } },
});

it("style: choosing a field the last render lacks asks for the layer's render", async () => {
  const saved = mapOf(base);
  const { w, h } = await loaded(saved);
  await editLayer(w, h, saved, { style: categorical("line") });
  const [again] = renderCalls(w);
  expect(again).toBeDefined();
  again.ok(drawn({ line: "red" }));
  await flush();
  expect(h.render().renders.renders.L).toEqual(drawn({ line: "red" }));
  h.unmount();
});

it.each([
  ["a label field", style, labelled("name"), {}],
  ["a label's thinning priority", labelled("name"), labelled("name", "riders"), { name: "Harbour" }],
] as const)("labels: %s the last render lacks asks for the layer's render", async (_, from, next, carried) => {
  const saved = mapOf({ ...base, style: from } as Layer);
  const { w, h } = await loaded(saved, drawn(carried));
  await editLayer(w, h, saved, { style: next });
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

it.each([
  ["an explicit tooltip field", { tooltip: ["name"] }],
  ["an explicit pop-up field", { popup: ["riders"] }],
  ["automatic interactions", { popup: null }],
])("interactions: %s the last render lacks asks for the layer's render", async (_, fields) => {
  const saved = mapOf(base);
  const { w, h } = await loaded(saved);
  await editLayer(w, h, saved, fields as Partial<Layer>);
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

const lines: MapWidget = {
  id: "w1", type: "category", layerId: "L", title: "Lines", field: "line",
  agg: "count", aggField: null, unit: null, note: null, format: null, visible: true,
};

it.each(["accepted", "recovered"] as const)("widgets: a widget reading a field the last render lacks asks for the layer's render, %s", async (outcome) => {
  const saved = mapOf(base);
  const { w, h } = await loaded(saved);
  h.value.widgets.apply([lines]);
  await flush();
  const added = { ...saved, widgets: [lines], editRevision: "r2" };
  const write = w.pending("PATCH", "/api/maps/m")[0];
  if (outcome === "accepted") write.ok(added);
  else {
    // The answer is lost; the read shows the widget stored.
    write.cut();
    await flush();
    w.pending("GET", "/api/maps/m")[0].ok(added);
  }
  await flush();
  const [again] = renderCalls(w);
  expect(again).toBeDefined();
  again.ok(drawn({ line: "A" }));
  await flush();
  // A title edit reads nothing new.
  h.render();
  h.value.widgets.apply([{ ...lines, title: "Line names" }]);
  await flush();
  w.pending("PATCH", "/api/maps/m")[0].ok({ ...added, widgets: [{ ...lines, title: "Line names" }], editRevision: "r3" });
  await flush();
  expect(renderCalls(w)).toHaveLength(0);
  h.unmount();
});

// Past the canvas's slot count the docked time range takes a delegated
// slot from the last range, so its field reaches the wire only once the
// dock is accepted.
const ranges: LayerFilter[] = ["a", "b", "c", "d"].map((field) => ({ field, kind: "range", min: 0, max: null }));
const crowded = { ...base, filters: [...ranges, { field: "opened", kind: "timerange", min: null, max: null }] } as Layer;

it("timeline: a dock on a field the last render lacks asks for the layer's render", async () => {
  const saved = mapOf(crowded);
  const { w, h } = await loaded(saved, drawn({ a: 1, b: 1, c: 1, d: 1 }));
  h.value.timeline.dock("L", "opened");
  await flush();
  w.pending("PATCH", "/api/maps/m")[0].ok({ ...saved, timeline: { layerId: "L", field: "opened", speed: 1 }, editRevision: "r2" });
  await flush();
  const [again] = renderCalls(w);
  expect(again).toBeDefined();
  again.ok(drawn({ a: 1, b: 1, c: 1, opened: "2024-01-02" }));
  await flush();
  // Undocking hands the slot back: the layer asks again for its split.
  h.render();
  h.value.timeline.undock();
  await flush();
  w.pending("PATCH", "/api/maps/m")[0].ok({ ...saved, editRevision: "r3" });
  await flush();
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

it("timeline: a dock that shifts a tiled layer's delegated filters asks for its render", async () => {
  // Tiles carry the archive's fields, but the time range now leaves the
  // archive's query for the canvas, so the layer asks again all the same.
  const saved = mapOf(crowded);
  const { w, h } = await loaded(saved, tiled);
  h.value.timeline.dock("L", "opened");
  await flush();
  w.pending("PATCH", "/api/maps/m")[0].ok({ ...saved, timeline: { layerId: "L", field: "opened", speed: 1 }, editRevision: "r2" });
  await flush();
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

it("a field-reading edit whose answer was lost asks for the render once a read confirms it", async () => {
  const saved = mapOf(base);
  const { w, h } = await loaded(saved);
  void h.value.mutations.patchLayer("L", { tooltip: ["name"] });
  await flush();
  w.pending("PATCH", "/api/layers/L")[0].cut();
  await flush();
  w.pending("GET", "/api/maps/m")[0].ok(mapOf({ ...base, tooltip: ["name"] } as Layer, { editRevision: "r2" }));
  await flush();
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

it("asks even where the caller skips the refetch, as a heatmap weight's release does", async () => {
  const heat = { ...base, viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: null } } as Layer;
  const saved = mapOf(heat);
  const { w, h } = await loaded(saved);
  await editLayer(w, h, saved, { viz: { type: "heatmap", radiusPx: 30, intensity: 1, weight: "riders" } }, { skipRefresh: true });
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

it("asks nothing for an edit that only stops reading a field", async () => {
  const saved = mapOf({ ...base, tooltip: ["name", "riders"] } as Layer);
  const { w, h } = await loaded(saved, drawn({ name: "Harbour", riders: 3 }));
  await editLayer(w, h, saved, { tooltip: ["name"] });
  expect(renderCalls(w)).toHaveLength(0);
  h.unmount();
});

it("leaves a tiled layer to its archive's rule: a widget edit asks nothing, a style edit asks as before", async () => {
  const saved = mapOf(base);
  const { w, h } = await loaded(saved, tiled);
  h.value.widgets.apply([lines]);
  await flush();
  w.pending("PATCH", "/api/maps/m")[0].ok({ ...saved, widgets: [lines], editRevision: "r2" });
  await flush();
  expect(renderCalls(w)).toHaveLength(0);
  h.render();
  await editLayer(w, h, saved, { style: categorical("line") });
  expect(renderCalls(w)).toHaveLength(1);
  h.unmount();
});

it("keeps the field render when an older answer for the layer lands after it", async () => {
  const saved = mapOf(base);
  const { w, h } = await loaded(saved);
  // An earlier request for the layer (a tile poll, a sketch edit's) is
  // still on the wire.
  void h.value.renders.refreshLayer("L");
  await flush();
  const [older] = renderCalls(w);
  await editLayer(w, h, saved, { tooltip: ["name"] });
  const [, newer] = renderCalls(w);
  newer.ok(drawn({ name: "Harbour" }));
  await flush();
  older.ok(drawn({}));
  await flush();
  expect(h.render().renders.renders.L).toEqual(drawn({ name: "Harbour" }));
  h.unmount();
});

import { afterEach, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "../workflow-canvas/hook-harness";
import { wire, type Wire } from "../workflow-canvas/fetch-wire";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import type { LayerRenderData } from "./render-data";
vi.mock("react", () => hookReact);
import { useLayerRenders } from "./use-layer-renders";
import { useBuilderMutations, useBuilderReload } from "./use-builder-mutations";
import { useDrawIntegration } from "./draw/use-draw-integration";
import { useBuilderLayerActions } from "./use-builder-layer-actions";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Each test holds one render answer on the wire, lets a newer one land,
// then releases the held one: the newer render must be what the builder
// shows. The paths are the builder's own, wired as MapBuilder wires them.

const layer = { id: "L", name: "Sketch", sql: "SELECT * FROM sketch_t", visible: true, filters: [], viz: { type: "points" }, style: { opacity: 1 } } as unknown as Layer;
const saved = { id: "m", name: "Map", layers: [layer], widgets: [], editRevision: "r1" } as unknown as MapWithLayers;
const history = { canUndo: true, canRedo: false, editRevision: "r1", undoTarget: { eligible: true, reason: null, steps: [] } };
const at = (lng: number, lat: number): LayerRenderData => ({
  layerId: "L", ok: true, mode: "inline", featureCount: 1, geometryType: "POINT",
  geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lng, lat] } }] },
});
const tiles = (state: "building" | "ready"): LayerRenderData => ({
  layerId: "L", ok: true, mode: "tiled", geometryType: "POINT",
  tiles: state === "ready" ? { state, url: "/tiles/L/{z}/{x}/{y}", bounds: [0, 0, 1, 1] } : { state },
});
const NO_LAYERS: Layer[] = [];
const noop = () => {};
// Fake timers drive the tile poll; the wire's own settle rides the
// clock, so answers flush through the check queue instead.
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
    const draw = useDrawIntegration({
      mapId: "m", request: mutations.request, reloadKey: mutations.reloadKey, reload: mutations.reload,
      selectLayer: noop, refreshLayer: renders.refreshLayer, layers: map?.layers ?? NO_LAYERS,
      announce: noop, offerPickedLayer: () => false,
    });
    const actions = useBuilderLayerActions({
      mutations, draw, mapId: "m", selectedId: null, setSelectedId: noop, setMap,
      removeRender: renders.removeRender, refreshLayer: renders.refreshLayer,
    });
    return { renders, mutations, draw, actions };
  });
  /** What the builder holds for the layer: its state and its ref agree. */
  const shown = () => {
    const { renders } = h.render();
    expect(renders.rendersRef.current).toEqual(renders.renders);
    return renders.renders;
  };
  return { h, shown };
}

async function loaded(w: Wire, first: LayerRenderData) {
  vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const builder = mountBuilder();
  await flush();
  w.pending("GET", "/api/maps/m")[0].ok(saved);
  await flush();
  w.pending("GET", "/api/maps/m/history")[0].ok(history);
  renderCalls(w)[0].ok(first);
  await flush();
  expect(builder.shown().L).toEqual(first);
  return builder;
}

/** A vertex of the layer's sketch moves: the write lands, then the
 * layer asks for its render again (the sketch session's own path). */
async function moveVertex(w: Wire, builder: ReturnType<typeof mountBuilder>) {
  void builder.h.value.draw.moveVertex({ layerId: "L", table: "sketch_t", featureId: "f1", kind: "point" }, 0, [1, 2]);
  await flush();
  w.pending("PATCH", "/api/sketches/sketch_t/features/f1")[0].ok({});
  await flush();
}

it("keeps a sketch edit's render when a reload's older answer lands after it", async () => {
  const w = wire();
  const builder = await loaded(w, at(0, 0));
  // A reload (an import, the assistant, a newly minted sketch layer)
  // reads the map and asks again for every layer's render.
  builder.h.value.mutations.reload();
  builder.h.render();
  await flush();
  w.pending("GET", "/api/maps/m")[0].ok(saved);
  await flush();
  const [reloadAnswer] = renderCalls(w);
  await moveVertex(w, builder);
  const [, editAnswer] = renderCalls(w);
  editAnswer.ok(at(1, 2));
  await flush();
  expect(builder.shown().L).toEqual(at(1, 2));
  reloadAnswer.ok(at(0, 0));
  await flush();
  expect(builder.shown().L).toEqual(at(1, 2));
  builder.h.unmount();
});

it("keeps a sketch edit's render when the undo's older answer lands after it", async () => {
  const w = wire();
  const builder = await loaded(w, at(0, 0));
  builder.h.render();
  void builder.h.value.mutations.applyHistory("undo");
  await flush();
  w.pending("POST", "/api/maps/m/undo")[0].ok({ ...saved, editRevision: "r0", history: { canUndo: false, canRedo: true } });
  await flush();
  const [undoAnswer] = renderCalls(w);
  await moveVertex(w, builder);
  const [, editAnswer] = renderCalls(w);
  editAnswer.ok(at(1, 2));
  await flush();
  expect(builder.shown().L).toEqual(at(1, 2));
  undoAnswer.ok(at(0, 0));
  await flush();
  expect(builder.shown().L).toEqual(at(1, 2));
  builder.h.unmount();
});

it("does not bring back a deleted layer's render when the tile poll answers after the delete", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const w = wire();
  const builder = await loaded(w, tiles("building"));
  vi.advanceTimersByTime(2500);
  const [pollAnswer] = renderCalls(w);
  expect(pollAnswer).toBeDefined();
  const deleting = builder.h.value.actions.deleteLayer("L");
  await flush();
  w.pending("DELETE", "/api/layers/L")[0].ok({});
  await deleting;
  expect(builder.shown()).not.toHaveProperty("L");
  pollAnswer.ok(tiles("ready"));
  await flush();
  expect(builder.shown()).not.toHaveProperty("L");
  // Nothing is left to poll for.
  vi.advanceTimersByTime(5000);
  expect(renderCalls(w)).toHaveLength(0);
  builder.h.unmount();
});

it("keeps a SQL edit's render when the tile poll's older answer lands after it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const w = wire();
  const builder = await loaded(w, tiles("building"));
  vi.advanceTimersByTime(2500);
  const [pollAnswer] = renderCalls(w);
  void builder.h.value.mutations.patchLayer("L", { sql: "SELECT * FROM sketch_t LIMIT 1" });
  await flush();
  w.pending("PATCH", "/api/layers/L")[0].ok({ ...layer, sql: "SELECT * FROM sketch_t LIMIT 1", editRevision: "r2" });
  await flush();
  const [, editAnswer] = renderCalls(w);
  editAnswer.ok(at(1, 2));
  await flush();
  expect(builder.shown().L).toEqual(at(1, 2));
  pollAnswer.ok(tiles("ready"));
  await flush();
  expect(builder.shown().L).toEqual(at(1, 2));
  builder.h.unmount();
});

it("drops the render of a layer the assistant's accepted document no longer has", async () => {
  const w = wire();
  vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const other = { ...layer, id: "K", name: "Other", sql: "SELECT 2" } as unknown as Layer;
  const builder = mountBuilder();
  await flush();
  w.pending("GET", "/api/maps/m")[0].ok({ ...saved, layers: [layer, other] });
  await flush();
  renderCalls(w)[0].ok(at(0, 0));
  w.pending("GET", "/api/layers/K/render")[0].ok({ ...at(5, 5), layerId: "K" });
  await flush();
  expect(Object.keys(builder.shown())).toEqual(["L", "K"]);
  // The assistant removed K; its turn installs the accepted document.
  const turn = builder.h.value.mutations.turn(async () => {});
  await flush();
  w.pending("GET", "/api/maps/m")[0].ok({ ...saved, editRevision: "r2" });
  await flush();
  expect(builder.shown()).not.toHaveProperty("K");
  renderCalls(w)[0].ok(at(1, 2));
  await turn;
  expect(builder.shown()).toEqual({ L: at(1, 2) });
  builder.h.unmount();
});

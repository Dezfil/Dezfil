import { afterEach, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "../workflow-canvas/hook-harness";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
vi.mock("react", () => hookReact);
import { useBuilderMutations } from "./use-builder-mutations";
import { useBuilderLayerActions } from "./use-builder-layer-actions";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
it.each(["lost", "stale"])("a %s reorder keeps its banner and rolls back only an unchanged document", async kind => {
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const original = { id: "m", editRevision: "seen", layers: [{ id: "a" }, { id: "b" }], widgets: [] } as unknown as MapWithLayers;
  let map = original;
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_path: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    if (init?.method === "PATCH") {
      if (kind === "lost") throw new TypeError("Failed to fetch");
      return Response.json({ error: { code: "stale_revision", message: "This item has changed. Reload it before trying again." } }, { status: 409 });
    }
    return Response.json(original);
  });
  const setMap: React.Dispatch<React.SetStateAction<MapWithLayers | null>> = next => { map = (typeof next === "function" ? next(map) : next)!; };
  const h = new HookHarness(() => {
    const mutations = useBuilderMutations({ mapId: "m", map, setMap, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    const actions = useBuilderLayerActions({ mutations, draw: {} as never, mapId: "m", selectedId: null, setSelectedId() {}, setMap, removeRender() {}, refreshLayer: async () => {} });
    return { ...mutations, ...actions };
  });
  cleanups.push(() => h.unmount());
  h.value.serverMapRef.current = original; h.value.sequence.accept(original);
  h.value.authoritativeLayersRef.current = Object.fromEntries(original.layers.map(layer => [layer.id, layer as Layer]));
  h.value.reorderLayers(["b", "a"]);
  expect(map.layers.map(layer => layer.id)).toEqual(["b", "a"]);
  await h.value.sequence.idle(); h.render();
  expect(h.value.failures.map).toContain(kind === "lost" ? "could not be confirmed" : "This item has changed");
  expect(map.layers.map(layer => layer.id)).toEqual(kind === "lost" ? ["a", "b"] : ["b", "a"]);
  expect(h.value.sequence.revision).toBe("seen");
  expect(requests).toHaveLength(kind === "lost" ? 2 : 1);
});

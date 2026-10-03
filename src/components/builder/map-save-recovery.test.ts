import { afterEach, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "../workflow-canvas/hook-harness";
import { wire } from "../workflow-canvas/fetch-wire";
import type { MapWithLayers } from "@/lib/metadata/maps";
vi.mock("react", () => hookReact);
import { useBuilderMutations } from "./use-builder-mutations";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
function setup() {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const initial = { id: "m", name: "Map", basemap: "light", basemapLayers: null, layers: [], widgets: [], editRevision: "seen" } as unknown as MapWithLayers;
  let map = initial;
  const h = new HookHarness(() => useBuilderMutations({ mapId: "m", map, setMap: next => { map = (typeof next === "function" ? next(map) : next)!; }, rendersRef: { current: {} }, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} }));
  cleanups.push(() => h.unmount());
  h.value.serverMapRef.current = initial; h.value.sequence.accept(initial);
  return { w, h, initial, shown: () => map };
}

it.each(["cut", "truncated", "bodyFailure"] as const)("reconciles a %s map response and chains queued intent without replaying the lost write", async failure => {
  const c = setup();
  const saved = c.h.value.patchMap({ basemap: "dark" });
  const next = c.h.value.patchMap({ name: "Queued name" });
  c.w.pending("PATCH", "/api/maps/m")[0][failure](); await c.w.settle();
  expect(c.w.pending("GET", "/api/maps/m")).toHaveLength(1);
  expect(c.w.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  c.w.pending("GET", "/api/maps/m")[0].ok({ ...c.initial, basemap: "dark", editRevision: "accepted", updatedAt: "now", lastChangedAt: "now" });
  await saved; await c.w.settle();
  expect(c.h.value.sequence.revision).toBe("accepted");
  expect(c.h.value.serverMapRef.current?.basemap).toBe("dark");
  expect(c.shown()).toMatchObject({ basemap: "dark", name: "Queued name" });
  const following = c.w.pending("PATCH", "/api/maps/m")[0];
  expect(following.body).toEqual({ name: "Queued name" });
  expect(following.headers.get("X-Edit-Revision")).toBe("accepted");
  expect(c.h.render().failures.map).toContain("could not be confirmed");
  following.ok({ ...c.initial, basemap: "dark", name: "Queued name", editRevision: "renamed" });
  await next;
  expect(c.h.render().failures.map).toBeUndefined();
});

it.each(["different edit", "matching field with another edit", "failed read", "stale refusal"])("keeps the draft and old basis after a %s", async failure => {
  const c = setup();
  const saved = c.h.value.patchMap({ basemap: "dark" });
  const patch = c.w.pending("PATCH", "/api/maps/m")[0];
  if (failure === "stale refusal") patch.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
  else patch.cut();
  await c.w.settle();
  const reads = c.w.pending("GET", "/api/maps/m");
  if (failure === "stale refusal") expect(reads).toHaveLength(0);
  else {
    expect(reads).toHaveLength(1);
    if (failure === "failed read") reads[0].cut();
    else reads[0].ok({ ...c.initial, name: "Someone else's name", basemap: failure === "different edit" ? "light" : "dark", editRevision: "foreign" });
  }
  await saved;
  expect(c.shown().basemap).toBe("dark");
  expect(c.h.value.serverMapRef.current?.basemap).toBe("light");
  expect(c.h.value.sequence.revision).toBe("seen");
  expect(c.w.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
});

import { afterEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { HookHarness, hookReact } from "../workflow-canvas/hook-harness";
import { wire } from "../workflow-canvas/fetch-wire";
vi.mock("react", () => hookReact);
import { useBuilderMutations } from "./use-builder-mutations";
import { useStyleAppearanceCommit } from "./use-style-appearance-commit";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
function setup() {
  const w = wire();
  const initial = { id: "m", name: "Map", editRevision: "seen", layers: [
    { id: "a", style: { opacity: 0.8 } }, { id: "b", style: { opacity: 1 } },
  ] } as unknown as MapWithLayers & { editRevision: string };
  let map = initial;
  let recovered: (MapWithLayers & { editRevision: string }) | null = initial;
  const fetch = vi.fn((...args: Parameters<typeof globalThis.fetch>) => {
    if (String(args[0]) === "/api/maps/m" && (!args[1]?.method || args[1].method === "GET")) {
      return recovered ? Promise.resolve(Response.json(recovered)) : Promise.reject(new Error("Offline"));
    }
    return w.fetch(...args);
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const clearAppearanceDraft = vi.fn();
  const h = new HookHarness(() => {
    const editor = useBuilderMutations({ mapId: "m", map, setMap: next => { map = (typeof next === "function" ? next(map) : next)! as typeof initial; }, rendersRef: { current: {} }, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} });
    return { ...editor, commit: useStyleAppearanceCommit({ ...editor, appearancePreviewVersionRef: { current: { a: 1, b: 1 } }, clearAppearanceDraft }) };
  });
  cleanups.push(() => h.unmount());
  h.value.applyMapResponse(initial, false, Infinity);
  return { h, w, fetch, initial, clearAppearanceDraft, read: (value: typeof recovered) => { recovered = value; }, opacity: (id: string) => String(map.layers.find(layer => layer.id === id)!.style.opacity) };
}

it("restores the failed layer's own opacity and keeps its banner through another layer's success", async () => {
  const c = setup();
  const lost = c.h.value.commit("b", { opacity: 0.6 });
  c.w.pending("PATCH", "/api/layers/b")[0].cut();
  expect(await lost).toBe(false);
  const other = c.h.value.commit("a", { opacity: 0.75 });
  await c.w.settle();
  c.w.pending("PATCH", "/api/layers/a")[0].ok({ ...c.initial.layers[0], style: { opacity: 0.75 }, editRevision: "other" });
  expect(await other).toBe(true);
  expect(c.opacity("a")).toBe("0.75");
  expect(c.opacity("b")).toBe("1");
  expect(c.h.render().failures["layer:b"]).toContain("could not be confirmed");
  expect(c.h.value.failures["layer:a"]).toBeUndefined();
  expect(c.h.value.drafts.hasLayer("b")).toBe(false);
  expect(c.clearAppearanceDraft).toHaveBeenCalledWith("b");
  const retry = c.h.value.commit("b", { opacity: 0.6 });
  await c.w.settle();
  const save = c.w.pending("PATCH", "/api/layers/b")[0];
  expect(save.headers.get("X-Edit-Revision")).toBe("other");
  save.ok({ ...c.initial.layers[1], style: { opacity: 0.6 }, editRevision: "retried" });
  expect(await retry).toBe(true);
  expect(c.h.render().failures["layer:b"]).toBeUndefined();
});

it("retires only the lost gesture while later gestures wait for their own answers", async () => {
  const c = setup();
  const lost = c.h.value.commit("b", { opacity: 0.6 });
  const queued = c.h.value.commit("b", { opacity: 0.4 });
  c.w.pending("PATCH", "/api/layers/b")[0].cut();
  await lost; await c.w.settle();
  expect(c.opacity("a")).toBe("0.8");
  expect(c.opacity("b")).toBe("0.4");
  expect(c.h.value.authoritativeLayersRef.current.b.style.opacity).toBe(1);
  const save = c.w.pending("PATCH", "/api/layers/b")[0];
  expect(save.body).toEqual({ style: { opacity: 0.4 } });
  expect(save.headers.get("X-Edit-Revision")).toBe("seen");
  save.ok({ ...c.initial.layers[1], style: { opacity: 0.4 }, editRevision: "queued" });
  expect(await queued).toBe(true);
});

it.each(["cut", "truncated", "bodyFailure"] as const)("reconciles a %s accepted layer response before the next layer writes", async failure => {
  const c = setup();
  c.read({ ...c.initial, editRevision: "accepted", layers: [c.initial.layers[0], { ...c.initial.layers[1], style: { ...c.initial.layers[1].style, opacity: 0.6 } }] });
  const lost = c.h.value.commit("b", { opacity: 0.6 });
  const queued = c.h.value.commit("a", { opacity: 0.75 });
  c.w.pending("PATCH", "/api/layers/b")[0][failure]();
  await lost; await c.w.settle();
  const save = c.w.pending("PATCH", "/api/layers/a")[0];
  expect(save.headers.get("X-Edit-Revision")).toBe("accepted");
  expect(c.opacity("b")).toBe("0.6");
  expect(c.h.value.drafts.hasLayer("b")).toBe(false);
  expect(c.w.calls.filter(call => call.path === "/api/layers/b")).toHaveLength(1);
  save.ok({ ...c.initial.layers[0], style: { opacity: 0.75 }, editRevision: "queued" });
  await queued;
  expect(c.h.render().failures["layer:b"]).toContain("could not be confirmed");
});

it.each(["another edit", "unreadable", "stale", "reloaded"])("keeps the layer draft and its old basis after an outcome that is %s", async outcome => {
  const c = setup();
  if (outcome === "another edit") c.read({ ...c.initial, name: "Elsewhere", editRevision: "foreign", layers: [c.initial.layers[0], { ...c.initial.layers[1], style: { ...c.initial.layers[1].style, opacity: 0.6 } }] });
  if (outcome === "unreadable") c.read(null);
  const lost = c.h.value.commit("b", { opacity: 0.6 });
  const save = c.w.pending("PATCH", "/api/layers/b")[0];
  if (outcome === "reloaded") c.h.value.reloadEpochRef.current++;
  if (outcome === "stale") save.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
  else save.cut();
  await lost;
  expect(c.opacity("b")).toBe("0.6");
  expect(c.h.value.drafts.hasLayer("b")).toBe(true);
  expect(c.h.value.sequence.revision).toBe("seen");
  if (outcome === "stale") expect(c.fetch.mock.calls.filter(([path]) => path === "/api/maps/m")).toHaveLength(0);
});

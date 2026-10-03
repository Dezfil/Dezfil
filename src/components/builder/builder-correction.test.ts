import { afterEach, expect, it, vi } from "vitest";
import { HookHarness, hookReact } from "../workflow-canvas/hook-harness";
import { wire } from "../workflow-canvas/fetch-wire";
import type { MapWithLayers } from "@/lib/metadata/maps";
vi.mock("react", () => hookReact);
import { useBuilderMutations } from "./use-builder-mutations";

afterEach(() => vi.unstubAllGlobals());
it("keeps failed opacity visible after fill saves and retires it only after an opacity correction", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const layer = { id: "a", sql: "SELECT 1", style: { opacity: 1, fill: "red" } };
  let map = { id: "m", layers: [layer], editRevision: "initial" } as unknown as MapWithLayers;
  const h = new HookHarness(() => useBuilderMutations({ mapId: "m", map, setMap: next => { map = typeof next === "function" ? next(map)! : next!; }, rendersRef: { current: {} }, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} }));
  const editor = h.value;
  editor.serverMapRef.current = map; editor.authoritativeLayersRef.current = { a: map.layers[0] }; editor.sequence.accept(map);
  const opacity = editor.patchLayer("a", { style: { opacity: 0.5, fill: "red" } });
  await w.settle(); w.pending("PATCH", "/api/layers/a")[0].cut();
  // Neither leg can establish the outcome. The draft must survive the
  // outage until its own field is corrected, even if a fill save lands.
  await w.settle(); w.pending("GET", "/api/maps/m")[0].cut();
  expect(await opacity).toBeNull(); h.render();
  expect(editor.drafts.hasLayer("a")).toBe(true);

  const fill = h.value.patchLayer("a", { style: { opacity: 0.5, fill: "blue" } });
  await w.settle();
  const savedFill = w.pending("PATCH", "/api/layers/a")[0];
  expect(savedFill.body).toEqual({ style: { opacity: 1, fill: "blue" } });
  savedFill.ok({ ...layer, style: { opacity: 1, fill: "blue" }, editRevision: "fill" });
  await fill; h.render();
  expect(editor.serverMapRef.current?.layers[0].style).toEqual({ opacity: 1, fill: "blue" });
  expect(map.layers[0].style).toEqual({ opacity: 0.5, fill: "blue" });
  expect(editor.drafts.hasLayer("a")).toBe(true);

  const corrected = h.value.patchLayer("a", { style: { opacity: 0.7, fill: "blue" } });
  await w.settle();
  const savedOpacity = w.pending("PATCH", "/api/layers/a")[0];
  expect(savedOpacity.headers.get("X-Edit-Revision")).toBe("fill");
  expect(savedOpacity.body).toEqual({ style: { opacity: 0.7, fill: "blue" } });
  savedOpacity.ok({ ...layer, style: { opacity: 0.7, fill: "blue" }, editRevision: "opacity" });
  await corrected;
  expect(map.layers[0].style).toEqual({ opacity: 0.7, fill: "blue" });
  expect(editor.drafts.hasLayer("a")).toBe(false);
  h.unmount();
});

it("retires refused SQL after an accepted correction and preserves unrelated and newer drafts", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const layer = { id: "a", sql: "SELECT 1", legendTitle: "original", style: { opacity: 1 } };
  let map = { id: "m", layers: [layer, { ...layer, id: "b" }], editRevision: "initial" } as unknown as MapWithLayers;
  const h = new HookHarness(() => useBuilderMutations({ mapId: "m", map, setMap: next => { map = typeof next === "function" ? next(map)! : next!; }, rendersRef: { current: {} }, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} }));
  const editor = h.value;
  editor.serverMapRef.current = map; editor.authoritativeLayersRef.current = Object.fromEntries(map.layers.map(l => [l.id, l])); editor.sequence.accept(map);
  const invalid = editor.patchLayer("a", { sql: "INVALID SQL", legendTitle: "keep this title" });
  await w.settle(); w.pending("PATCH", "/api/layers/a")[0].refuse(400, "invalid_request", "Invalid SQL");
  expect(await invalid).toBeNull(); h.render();
  expect(h.value.failures["layer:a"]).toBe("Invalid SQL");
  const other = h.value.patchLayer("b", { sql: "OTHER INVALID SQL" });
  await w.settle(); w.pending("PATCH", "/api/layers/b")[0].refuse(400, "invalid_request", "Invalid SQL"); await other; h.render();
  const correction = h.value.patchLayer("a", { sql: "SELECT 2" });
  await w.settle();
  const newer = h.value.patchLayer("a", { style: { opacity: 0.5 } });
  w.pending("PATCH", "/api/layers/a")[0].ok({ ...layer, sql: "SELECT 2", editRevision: "corrected" });
  await correction; await w.settle(); h.render();
  expect(editor.serverMapRef.current?.layers[0].sql).toBe("SELECT 2");
  expect(map.layers[0]).toMatchObject({ sql: "SELECT 2", legendTitle: "keep this title", style: { opacity: 0.5 } });
  expect(map.layers[1].sql).toBe("OTHER INVALID SQL");
  expect(h.value.failures["layer:a"]).toBeUndefined();
  w.pending("PATCH", "/api/layers/a")[0].ok({ ...layer, sql: "SELECT 2", style: { opacity: 0.5 }, editRevision: "styled" }); await newer;
  expect(editor.drafts.hasLayer("a")).toBe(true);
  h.render(); const title = h.value.patchLayer("a", { legendTitle: "corrected title" }); await w.settle();
  w.pending("PATCH", "/api/layers/a")[0].ok({ ...map.layers[0], legendTitle: "corrected title", editRevision: "title" }); await title;
  expect(editor.drafts.hasLayer("a")).toBe(false);
  h.unmount();
});

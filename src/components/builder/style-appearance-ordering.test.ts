import { afterEach, expect, it, vi } from "vitest";
import { HookHarness, hookReact } from "../workflow-canvas/hook-harness";
import { wire } from "../workflow-canvas/fetch-wire";
import type { MapWithLayers } from "@/lib/metadata/maps";
vi.mock("react", () => hookReact);
import { useBuilderMutations } from "./use-builder-mutations";
import { useStyleAppearanceCommit } from "./use-style-appearance-commit";

afterEach(() => vi.unstubAllGlobals());
it("queues a reset to the original opacity behind the outstanding gesture", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const layer = { id: "a", sql: "SELECT 1", style: { opacity: 1 } };
  let map = { id: "m", layers: [layer], editRevision: "initial" } as unknown as MapWithLayers;
  const appearancePreviewVersionRef = { current: { a: 1 } };
  const clearAppearanceDraft = vi.fn();
  const h = new HookHarness(() => {
    const editor = useBuilderMutations({ mapId: "m", map, setMap: next => { map = typeof next === "function" ? next(map)! : next!; }, rendersRef: { current: {} }, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} });
    return { editor, commit: useStyleAppearanceCommit({ ...editor, appearancePreviewVersionRef, clearAppearanceDraft }) };
  });
  const { editor, commit } = h.value;
  editor.serverMapRef.current = map; editor.authoritativeLayersRef.current = { a: map.layers[0] }; editor.sequence.accept(map);
  const first = commit("a", { opacity: 0.5 });
  appearancePreviewVersionRef.current.a++;
  let resetSettled = false;
  const reset = commit("a", { opacity: 1 }).then(value => { resetSettled = true; return value; });
  await w.settle();
  expect(resetSettled).toBe(false);
  expect(clearAppearanceDraft).not.toHaveBeenCalled();
  expect(w.pending("PATCH", "/api/layers/a")).toHaveLength(1);
  w.pending("PATCH", "/api/layers/a")[0].ok({ ...layer, style: { opacity: 0.5 }, editRevision: "half" });
  expect(await first).toBe(true); await w.settle();
  const request = w.pending("PATCH", "/api/layers/a")[0];
  expect(request.body).toEqual({ style: { opacity: 1 } });
  expect(request.headers.get("X-Edit-Revision")).toBe("half");
  request.ok({ ...layer, editRevision: "reset" });
  expect(await reset).toBe(true);
  expect(editor.authoritativeLayersRef.current.a.style.opacity).toBe(1);
  expect(clearAppearanceDraft).toHaveBeenCalledExactlyOnceWith("a");
  // A genuine no-op is decided after reaching its turn and sends nothing.
  const calls = w.calls.length;
  expect(await commit("a", { opacity: 1 })).toBe(true);
  expect(w.calls).toHaveLength(calls);
  expect(editor.drafts.hasLayer("a")).toBe(false);
  h.unmount();
});

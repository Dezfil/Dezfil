import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { BuilderSavedState, LayerDraftFields, UnsavedField, UnsavedLayer } from "./UnsavedFields";
import { readBuilderRecovery } from "./BuilderRecovery";
import { BuilderDrafts } from "./builder-drafts";
afterEach(() => vi.unstubAllGlobals());

it("marks changed radius, color and the layer card only after refusal", () => {
  const layer = { id: "layer", style: { pointRadius: 7, fill: "red", opacity: 1 } } as unknown as Layer;
  const changed = { ...layer, style: { ...layer.style, pointRadius: 10 } };
  const saved = { layers: [layer] } as unknown as MapWithLayers;
  const paint = (stale: boolean) => renderToStaticMarkup(<BuilderSavedState value={{ stale, saved }}>
    <LayerDraftFields layer={changed}><UnsavedField label="Radius" /><UnsavedField label="Color" /></LayerDraftFields>
    <UnsavedLayer layer={changed} /></BuilderSavedState>);
  expect(paint(false)).not.toContain("data-unsaved");
  expect(paint(true).match(/data-unsaved/g)).toHaveLength(2);
});

it("a failed reload changes no held draft and a successful read submits nothing", async () => {
  const saved = { id: "map", editRevision: "seen", layers: [{ id: "a", sql: "old" }] } as unknown as MapWithLayers;
  const drafts = new BuilderDrafts(); drafts.layer("a", () => ({ sql: "keep me" }));
  const request = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "internal_error", message: "Failed" } }, { status: 500 }))
    .mockResolvedValueOnce(Response.json({ ...saved, editRevision: "current", layers: [] }));
  vi.stubGlobal("fetch", request);
  await expect(readBuilderRecovery("map")).rejects.toThrow();
  expect(drafts.apply(saved).layers[0].sql).toBe("keep me");
  expect((await readBuilderRecovery("map")).map).toMatchObject({ editRevision: "current" });
  expect(request.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

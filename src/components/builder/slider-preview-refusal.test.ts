import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hookReact, HookHarness } from "../workflow-canvas/hook-harness";
import { wire, type Wire } from "../workflow-canvas/fetch-wire";
import type { Layer } from "@/lib/metadata/maps";
import type { LayerFilter } from "@/lib/viz";
import type { SliderPreviewData, SliderPreviewWork } from "@/lib/slider-preview";
vi.mock("react", () => hookReact);
import { useQuerySliderPreview } from "./use-query-slider-preview";

// A slider preview the server refuses as larger than Bytes drawn per layer
// is not asked for again on every pointer move of the same drag: each ask
// would read the same answer up to the limit for the same refusal. Nothing
// previews, no draft stands in for the layer, and the layer's own render
// follows the settled slider as before.

const posted: SliderPreviewWork[] = [];
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(work: SliderPreviewWork) { posted.push(work); }
  terminate() {}
}

let w: Wire;
beforeEach(() => {
  posted.length = 0;
  w = wire();
  vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

const layer = {
  id: "L", mapId: "m", name: "Stations", sql: "SELECT * FROM stations", visible: true,
  filters: [{ field: "riders", kind: "range", min: 10, max: null }], viz: { type: "points" },
  style: {}, tooltip: [], popup: [], publishedFields: null,
} as unknown as Layer;
const moved = (min: number): LayerFilter[] => [{ field: "riders", kind: "range", min, max: null }];
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const previewReads = () => w.calls.filter((c) => c.path === "/api/layers/L/slider-preview");
const REFUSAL = "This layer's preview is larger than 1,024 bytes, the limit for one layer drawn in the map, so the map shows the change when you let go.";
const source: SliderPreviewData = {
  layerId: "L", exact: true, sourceCount: 1, sampledCount: 1, budget: 50000, fields: [{ name: "riders", kind: "numeric" }],
  geojson: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { riders: 12 } }] },
};

function mount() {
  const errors: string[] = [];
  const h = new HookHarness(() => useQuerySliderPreview({ onError: (message) => errors.push(message), onSuccess: () => {} }));
  return { h, errors };
}

it("asks once for a refused preview while the source stands, and draws no draft", async () => {
  const { h, errors } = mount();
  void h.value.prepare(layer);
  await flush();
  previewReads()[0].refuse(422, "render_bytes_exceeded", REFUSAL);
  await flush();
  h.render();
  expect(errors).toEqual([REFUSAL]);

  for (const min of [20, 30, 40]) h.value.preview(layer, layer.viz, moved(min));
  await flush();
  h.render();
  expect(previewReads()).toHaveLength(1);
  expect(errors).toHaveLength(1);
  expect(posted).toEqual([]);
  expect(h.value.drafts).toEqual({});

  // Releasing the slider ends the interaction; the layer's own render draws.
  h.value.end("L");
  h.render();
  expect(h.value.drafts).toEqual({});
});

it("asks again once the source changes", async () => {
  const { h } = mount();
  void h.value.prepare(layer);
  await flush();
  previewReads()[0].refuse(422, "render_bytes_exceeded", REFUSAL);
  await flush();
  const narrower = { ...layer, sql: "SELECT * FROM stations WHERE riders > 5" } as Layer;
  h.value.preview(narrower, narrower.viz, moved(20));
  await flush();
  expect(previewReads()).toHaveLength(2);
  previewReads()[1].ok(source);
  await flush();
  expect(posted).toHaveLength(1);
});

it("keeps retrying a preview that failed for another reason", async () => {
  const { h, errors } = mount();
  void h.value.prepare(layer);
  await flush();
  previewReads()[0].cut();
  await flush();
  h.value.preview(layer, layer.viz, moved(20));
  await flush();
  expect(previewReads()).toHaveLength(2);
  expect(errors).toHaveLength(1);
});

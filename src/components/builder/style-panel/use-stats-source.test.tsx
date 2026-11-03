import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { normalizeStyle } from "@/lib/style/style";
import { DocumentEditorContext } from "../../document-editor-context";
import { installDomHost } from "../../testing/dom-host";
import { wire } from "../../workflow-canvas/fetch-wire";
import { useBuilderMutations } from "../use-builder-mutations";
import { useRampStats } from "./use-ramp-stats";
import { useStyleEditing } from "./use-style-editing";

/**
 * The histogram reads the values the server holds. A filter edit shows at
 * once, but its save lands later, so a read asked in between answers for
 * the old values. The seeded defect is the read keyed on the shown layer:
 * it asked as soon as the filter showed, got the unfiltered distribution,
 * and when the save landed nothing asked again, so the histogram kept
 * showing values the filter removes.
 */

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });

const READ = "/api/layers/layer/fields/v?distribution=classification";
const answer = (min: number) => ({
  field: "v", kind: "numeric", numeric: true, min, max: 73, mean: 4, bins: [1],
  distribution: "classification", axis: "log", edges: [min, 73], wholeNumbers: true,
});
const fields = { styling: [{ name: "v", type: "BIGINT", numeric: true, kind: "numeric" }], filterable: [], geometryColumns: [] };

function mount() {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const host = installDomHost();
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const layer = { id: "layer", sql: "SELECT * FROM collisions", style: normalizeStyle({}), viz: { type: "points" }, filters: [], tooltip: null, popup: null } as unknown as Layer;
  const initial = { id: "map", editRevision: "initial", layers: [layer] } as unknown as MapWithLayers;
  let editor!: ReturnType<typeof useBuilderMutations>;
  function Histogram({ layer }: { layer: Layer }) {
    const { fetchStats } = useStyleEditing({ layer, onStyle() {}, onViz() {} });
    const stats = useRampStats(fetchStats, "v", "classification");
    return <i data-shown={stats?.kind === "numeric" ? String(stats.min) : "none"} />;
  }
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(initial);
    editor = useBuilderMutations({ mapId: "map", map, setMap, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    if (!editor.sequence.revision) {
      editor.sequence.accept(initial);
      editor.serverMapRef.current = initial;
      editor.authoritativeLayersRef.current = { layer };
    }
    return <DocumentEditorContext.Provider value={editor}><Histogram layer={map!.layers[0]} /></DocumentEditorContext.Provider>;
  }
  return {
    w, layer,
    get editor() { return editor; },
    start: async () => {
      await flush(() => root.render(<Builder />));
      await flush(() => w.pending("GET", "/api/layers/layer/fields").forEach(read => read.ok(fields)));
      await flush(() => w.pending("GET", READ).forEach(read => read.ok(answer(1))));
    },
    shown: () => container.querySelector("i")?.getAttribute("data-shown"),
  };
}

it("reads a filtered layer's distribution once the server holds the filter", async () => {
  const panel = mount();
  await panel.start();
  expect(panel.shown()).toBe("1");

  const filters = [{ field: "v", kind: "range", min: 3, max: null }];
  await flush(() => { void panel.editor.patchLayer("layer", { filters }); });
  // The server answers any read asked before the save with the old values.
  await flush(() => panel.w.pending("GET", READ).forEach(read => read.ok(answer(1))));
  await flush(() => panel.w.pending("PATCH", "/api/layers/layer")[0].ok({ ...panel.layer, filters, editRevision: "filtered" }));
  expect(panel.w.pending("GET", READ), "the saved filter is read").toHaveLength(1);
  await flush(() => panel.w.pending("GET", READ).forEach(read => read.ok(answer(3))));
  expect(panel.shown()).toBe("3");
});

it("keeps the distribution through a paint edit, without reading it again", async () => {
  const panel = mount();
  await panel.start();
  const style = { ...panel.layer.style, opacity: 0.5 };
  await flush(() => { void panel.editor.patchLayer("layer", { style }); });
  expect(panel.shown()).toBe("1");
  expect(panel.w.pending("GET", READ)).toHaveLength(0);
  await flush(() => panel.w.pending("PATCH", "/api/layers/layer")[0].ok({ ...panel.layer, style, editRevision: "painted" }));
  expect(panel.shown()).toBe("1");
  expect(panel.w.pending("GET", READ)).toHaveLength(0);
});

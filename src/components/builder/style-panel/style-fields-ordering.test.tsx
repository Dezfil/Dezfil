import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { Layer, MapWithLayers } from "@/lib/metadata/maps";
import { normalizeStyle } from "@/lib/style/style";
import { defaultViz } from "@/lib/viz";
import { DocumentEditorContext } from "../../document-editor-context";
import { installDomHost } from "../../testing/dom-host";
import { wire } from "../../workflow-canvas/fetch-wire";
import { HoverFieldsSections } from "./HoverFieldsSections";
import { useStyleEditing } from "./use-style-editing";
import { useBuilderMutations } from "../use-builder-mutations";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
const fields = (...names: string[]) => ({
  styling: names.map(name => ({ name, type: "VARCHAR", numeric: false, kind: "text" })),
  filterable: [], geometryColumns: [],
});

function mountFields(tooltip: string[] | null = null, type: "hexbin" | "points" = "hexbin") {
  const host = installDomHost();
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const onTooltip = vi.fn(), onPopup = vi.fn();
  const layer = { id: "layer", sql: "SELECT * FROM stations", style: normalizeStyle({}), viz: defaultViz(type), tooltip, popup: null } as Layer;
  const initial = { id: "map", editRevision: "initial", layers: [layer], widgetsPublished: true } as unknown as MapWithLayers;
  let editor!: ReturnType<typeof useBuilderMutations>;
  function Fields({ layer }: { layer: Layer }) {
    const { stylingFields, switchViz } = useStyleEditing({ layer, onStyle() {}, onViz: viz => { void editor.patchLayer(layer.id, { viz }); } });
    return <>
      <button onClick={() => switchViz("hexbin")}>Hex bins</button>
      <button onClick={() => switchViz("points")}>Points</button>
      <HoverFieldsSections layer={layer} fields={stylingFields} onTooltip={onTooltip} onPopup={onPopup} />
    </>;
  }
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(initial);
    editor = useBuilderMutations({ mapId: "map", map, setMap, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    if (!editor.sequence.revision) {
      editor.sequence.accept(initial);
      editor.serverMapRef.current = initial;
      editor.authoritativeLayersRef.current = { layer };
    }
    return <DocumentEditorContext.Provider value={editor}><Fields layer={map!.layers[0]} /></DocumentEditorContext.Provider>;
  }
  return {
    get editor() { return editor; },
    layer, initial, onTooltip,
    mount: () => flush(() => root.render(<Builder />)),
    accept: (next: Layer) => flush(() => editor.applyMapResponse({ ...initial, layers: [next] }, false, Infinity)),
    choose: (label: string) => flush(() => container.querySelectorAll("button").find(button => button.textContent === label)!.click()),
    switches: () => container.querySelectorAll('[role="switch"]'),
    names: () => container.querySelectorAll('input[type="checkbox"]').filter(input => input.getAttribute("role") !== "switch").map(input => input.parentElement?.textContent),
  };
}

it("waits for a visualization save before offering its tooltip and popup fields", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const panel = mountFields();
  await panel.mount();
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("value", "count")));
  expect(panel.switches().every(input => !input.disabled)).toBe(true);

  const points = { ...panel.layer, viz: defaultViz("points") };
  await panel.choose("Points");
  expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(0);
  expect(panel.switches().every(input => input.disabled)).toBe(true);
  expect(panel.names()).toEqual([]);
  await flush(() => w.pending("PATCH", "/api/layers/layer")[0].ok(points));
  expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(1);
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("name")));
  expect(panel.switches().every(input => !input.disabled)).toBe(true);
  await flush(() => { const input = panel.switches()[0]; input.checked = false; input.click(); });
  expect(panel.onTooltip).toHaveBeenLastCalledWith(["name"]);
  await panel.accept({ ...points, tooltip: ["name"] });
  await flush(() => w.pending("GET", "/api/layers/layer/fields").forEach(read => read.ok(fields("name"))));
  expect(panel.names()).toEqual(["name"]);
});

it("discards a superseded field response even when its body arrives last", async () => {
  let releaseBody!: (value: unknown) => void;
  const body = new Promise(resolve => { releaseBody = resolve; });
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: () => body })
    .mockResolvedValueOnce(Response.json(fields("name")));
  vi.stubGlobal("fetch", fetcher);
  const panel = mountFields(["name"]);
  await panel.mount();
  await panel.accept({ ...panel.layer, viz: defaultViz("points") });
  expect(panel.names()).toEqual(["name"]);
  await flush(() => releaseBody(fields("value", "count")));
  expect(panel.names()).toEqual(["name"]);
});

it("keeps cached point fields unavailable through earlier map saves and its own held visualization write", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const panel = mountFields(null, "points");
  const { layer, initial, switches } = panel;
  const expectUnavailable = () => {
    expect(switches()).toHaveLength(2);
    expect(switches().map(input => input.disabled)).toEqual([true, true]);
    expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(0);
  };
  await panel.mount();
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("name")));
  expect(switches().map(input => input.disabled)).toEqual([false, false]);

  await flush(() => { void panel.editor.patchMap({ widgetsPublished: false }); });
  await flush(() => { void panel.editor.patchMap({ widgetsPublished: true }); });
  await panel.choose("Hex bins");
  await panel.choose("Points");
  expect(w.pending("PATCH", "/api/layers/layer")).toHaveLength(0);
  expectUnavailable();
  await flush(() => w.pending("PATCH", "/api/maps/map")[0].ok({ ...initial, widgetsPublished: false, editRevision: "widgets-off" }));
  expect(w.pending("PATCH", "/api/layers/layer")).toHaveLength(0);
  expectUnavailable();
  await flush(() => w.pending("PATCH", "/api/maps/map")[0].ok({ ...initial, editRevision: "widgets-on" }));
  expect(w.pending("PATCH", "/api/layers/layer")[0].body).toMatchObject({ viz: { type: "hexbin" } });
  expectUnavailable();
  await flush(() => w.pending("PATCH", "/api/layers/layer")[0].ok({ ...layer, viz: defaultViz("hexbin"), editRevision: "hexbin" }));
  const points = w.pending("PATCH", "/api/layers/layer")[0];
  expect(points.body).toMatchObject({ viz: { type: "points" } });
  expect(points.headers.get("X-Edit-Revision")).toBe("hexbin");
  expectUnavailable();
  // A later unrelated save must not delay reading this accepted layer.
  await flush(() => { void panel.editor.patchMap({ name: "Later name" }); });
  await flush(() => points.ok({ ...layer, editRevision: "points" }));
  expect(w.pending("PATCH", "/api/maps/map")).toHaveLength(1);
  expect(switches().map(input => input.disabled)).toEqual([true, true]);
  expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(1);
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("name")));
  expect(switches().map(input => input.disabled)).toEqual([false, false]);
});

it.each(["refused", "body failure"] as const)("keeps fields unavailable after a visualization save is %s", async outcome => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const panel = mountFields();
  await panel.mount();
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("value", "count")));
  await panel.choose("Points");
  const save = w.pending("PATCH", "/api/layers/layer")[0];
  await flush(() => outcome === "refused"
    ? save.refuse(409, "stale_revision", "This item has changed. Reload it before trying again.")
    : save.bodyFailure());
  expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(0);
  expect(panel.switches().map(input => input.disabled)).toEqual([true, true]);
});

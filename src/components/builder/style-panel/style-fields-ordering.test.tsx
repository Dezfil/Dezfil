import { act } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { Layer } from "@/lib/metadata/maps";
import { normalizeStyle } from "@/lib/style/style";
import { defaultViz } from "@/lib/viz";
import { DocumentSequence } from "../../document-sequence";
import { DocumentEditorContext } from "../../document-editor-context";
import { installDomHost } from "../../testing/dom-host";
import { wire } from "../../workflow-canvas/fetch-wire";
import { HoverFieldsSections } from "./HoverFieldsSections";
import { useStyleEditing } from "./use-style-editing";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
const fields = (...names: string[]) => ({
  styling: names.map(name => ({ name, type: "VARCHAR", numeric: false, kind: "text" })),
  filterable: [], geometryColumns: [],
});

function mountFields(tooltip: string[] | null = null) {
  const host = installDomHost();
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const sequence = new DocumentSequence("map");
  const onTooltip = vi.fn(), onPopup = vi.fn();
  const layer = { id: "layer", sql: "SELECT * FROM stations", style: normalizeStyle({}), viz: defaultViz("hexbin"), tooltip, popup: null } as Layer;
  const port = { sequence, request: fetch, turn: async (work: () => Promise<void>) => work() };
  function Fields({ layer }: { layer: Layer }) {
    const { stylingFields } = useStyleEditing({ layer, onStyle() {}, onViz() {} });
    return <HoverFieldsSections layer={layer} fields={stylingFields} onTooltip={onTooltip} onPopup={onPopup} />;
  }
  return {
    sequence, layer, onTooltip,
    render: (next: Layer) => flush(() => root.render(<DocumentEditorContext.Provider value={port}><Fields layer={next} /></DocumentEditorContext.Provider>)),
    switches: () => container.querySelectorAll('[role="switch"]'),
    names: () => container.querySelectorAll('input[type="checkbox"]').filter(input => input.getAttribute("role") !== "switch").map(input => input.parentElement?.textContent),
  };
}

it("waits for a visualization save before offering its tooltip and popup fields", async () => {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const panel = mountFields();
  await panel.render(panel.layer);
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("value", "count")));
  expect(panel.switches().every(input => !input.disabled)).toBe(true);

  const saving = panel.sequence.enqueue(() => fetch("/api/layers/layer", { method: "PATCH" }));
  const points = { ...panel.layer, viz: defaultViz("points") };
  await panel.render(points);
  expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(0);
  expect(panel.switches().every(input => input.disabled)).toBe(true);
  expect(panel.names()).toEqual([]);
  await flush(() => w.pending("PATCH", "/api/layers/layer")[0].ok(points));
  await saving;
  expect(w.pending("GET", "/api/layers/layer/fields")).toHaveLength(1);
  await flush(() => w.pending("GET", "/api/layers/layer/fields")[0].ok(fields("name")));
  expect(panel.switches().every(input => !input.disabled)).toBe(true);
  await flush(() => { const input = panel.switches()[0]; input.checked = false; input.click(); });
  expect(panel.onTooltip).toHaveBeenLastCalledWith(["name"]);
  await panel.render({ ...points, tooltip: ["name"] });
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
  await panel.render(panel.layer);
  await panel.render({ ...panel.layer, viz: defaultViz("points") });
  expect(panel.names()).toEqual(["name"]);
  await flush(() => releaseBody(fields("value", "count")));
  expect(panel.names()).toEqual(["name"]);
});

import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/style";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire, type Wire } from "../workflow-canvas/fetch-wire";
import { legendItems } from "../map/LegendPanel";
import { LegendTab } from "./LegendTab";
import { useBuilderMutations } from "./use-builder-mutations";
import { useLegendLayers } from "./use-legend-layers";
import { useLegendTab } from "./use-legend-tab";

// The rows' drag sorting measures laid-out boxes this host does not draw;
// the rows render as the list renders them, without it.
vi.mock("../widgets/SortableCards", async () => {
  const { Fragment, createElement } = await import("react");
  return {
    SortableCards: ({ ids, render }: { ids: string[]; render: (id: string, floating: boolean) => React.ReactNode }) =>
      ids.map(id => createElement(Fragment, { key: id }, render(id, false))),
  };
});

/**
 * A refused legend save through the Legend tab's editor, wired as the
 * builder wires it: the editor's live text and saves, the mutation lane,
 * and the legend the panel draws from them (the panel's own item rule).
 * The layer stores the legend title "Stored title" and the fill variable
 * name "Stored fill"; its fill is classed and its radius sized, so it has a
 * fill and a radius variable name to edit.
 */

const style: LayerStyle = {
  ...defaultStyle("POINT"),
  fill: { type: "quantile", attribute: "kind", palette: "viridis", breaks: [10], colors: [{ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }] },
  pointRadiusBy: { attribute: "pop", domain: [1, 100], range: [4, 20] },
};
const stored = { id: "a", mapId: "m", name: "Harbours", visible: true, inLegend: true, viz: { type: "points" }, style, filters: [],
  legendTitle: "Stored title", legendLabels: null, legendAttrs: { fill: "Stored fill" } };
const initial = { id: "m", name: "Map", editRevision: "seen", legendOrder: null, layers: [stored] } as unknown as MapWithLayers;

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let w: Wire;
/** The builder's hooks as last drawn. */
const builderRef = { current: null as unknown as ReturnType<typeof useBuilderMutations> & { legend: ReturnType<typeof useLegendLayers> } };

function Builder() {
  const [map, setMap] = useState<MapWithLayers | null>(initial);
  const rendersRef = useRef({});
  const editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, setRenders() {}, setSelectedId() {}, refreshLayer: async () => {} });
  const tab = useLegendTab({ ...editor, setMap });
  const legend = useLegendLayers({ map, renders: {}, legendLive: editor.legendLive, appearanceDrafts: {} });
  useEffect(() => { builderRef.current = { ...editor, legend }; });
  return <LegendTab layers={map?.layers ?? []} corner={null} legendOrder={null} onLive={editor.onLegendLive} {...tab} />;
}

beforeEach(async () => {
  w = wire();
  vi.stubGlobal("fetch", vi.fn((...args: Parameters<typeof globalThis.fetch>) => w.fetch(...args)));
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root.render(<Builder />));
  await act(async () => builderRef.current.applyMapResponse(initial, false, Infinity));
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await w.settle(); });
}
function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const field = (label: string) => host.document.querySelector(`input[aria-label="${label}, Harbours"]`)!;
const TITLE = "Legend title";
const FILL = "fill variable name";
const RADIUS = "radius variable name";
/** The author types into a field, the caret in it. */
async function type(label: string, text: string) {
  field(label).focus();
  await act(async () => props(field(label)).onChange({ target: { value: text } }));
}
/** The author leaves the field: the editor saves what it holds. */
async function leave(label: string) {
  field(label).blur();
  await act(async () => props(field(label)).onBlur({}));
}
const drawn = () => legendItems(builderRef.current.legend)[0];
const answer = (index = 0) => w.pending("PATCH", "/api/layers/a")[index];

it("keeps a title typed since a refused save, in the editor and on the legend", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  await type(TITLE, "Title B");
  answer().refuse(400, "invalid_request", "legendTitle is too long.");
  await settle();
  expect(field(TITLE).value, "the editor dropped text typed since the refused save").toBe("Title B");
  expect(drawn().title).toBe("Title B");
  await leave(TITLE);
  expect(answer().body).toEqual({ legendTitle: "Title B" });
});

it("shows the stored title again where nothing was typed since the refused save", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  answer().refuse(400, "invalid_request", "legendTitle is too long.");
  await settle();
  expect(field(TITLE).value).toBe("Stored title");
  expect(drawn().title).toBe("Stored title");
});

it("keeps a variable name typed since a refused save and shows the stored one where nothing was typed", async () => {
  await type(FILL, "Fill A");
  await leave(FILL);
  await type(RADIUS, "Radius B");
  answer().refuse(400, "invalid_request", "legendAttrs is not valid.");
  await settle();
  expect(field(FILL).value).toBe("Stored fill");
  expect(field(RADIUS).value, "the editor dropped text typed since the refused save").toBe("Radius B");
});

it("keeps a label typed since a refused save and shows the stored one where nothing was typed", async () => {
  const label = (n: number) => `Legend label ${n}`;
  await type(label(1), "One A");
  await leave(label(1));
  await type(label(2), "Two B");
  answer().refuse(400, "invalid_request", "legendLabels is not valid.");
  await settle();
  expect(field(label(1)).value).toBe("");
  expect(field(label(2)).value, "the editor dropped text typed since the refused save").toBe("Two B");
});

it("still takes another surface's change over text being typed once its own save was stored", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  answer().ok({ ...stored, legendTitle: "Title A", editRevision: "stored" });
  await settle();
  await type(TITLE, "Title B");
  await act(async () => builderRef.current.applyMapResponse({ ...initial, editRevision: "elsewhere",
    layers: [{ ...stored, legendTitle: "Elsewhere" }] } as unknown as MapWithLayers, false, Infinity));
  expect(field(TITLE).value).toBe("Elsewhere");
});

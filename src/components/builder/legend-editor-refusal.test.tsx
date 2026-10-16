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
 * The Legend tab's editor never overwrites the field the author is typing
 * in. Stored legend text changes under the editor three ways: the answer
 * to its own save, the rollback of a refused save, and a change from
 * elsewhere (another surface, an undo, the assistant). Every other field
 * takes the stored text; the one with the caret keeps what was typed, the
 * legend on the map shows the same, and leaving the field saves it.
 *
 * Wired as the builder wires it: the editor's live text and saves, the
 * mutation lane, and the legend the panel draws from them (the panel's
 * own item rule), the server's answers given by hand. The layer stores the
 * legend title "Stored title" and the fill variable name "Stored fill";
 * its fill is classed in two and its radius sized, so it has a fill and a
 * radius variable name and three label slots to edit.
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
/** Takes the Legend tab off the screen and puts it back. */
const shownRef = { current: null as unknown as (shown: boolean) => void };

function Builder() {
  const [map, setMap] = useState<MapWithLayers | null>(initial);
  const [shown, setShown] = useState(true);
  const rendersRef = useRef({});
  const editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
  const tab = useLegendTab({ ...editor, setMap });
  const legend = useLegendLayers({ map, renders: {}, legendLive: editor.legendLive, appearanceDrafts: {} });
  useEffect(() => { builderRef.current = { ...editor, legend }; });
  useEffect(() => { shownRef.current = setShown; }, []);
  if (!shown) return null;
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
const label = (n: number) => `Legend label ${n}`;
/** The author types into a field, the caret in it. */
async function type(name: string, text: string) {
  field(name).focus();
  await act(async () => props(field(name)).onChange({ target: { value: text } }));
}
/** The author leaves the field: the editor saves what it holds. */
async function leave(name: string) {
  field(name).blur();
  await act(async () => props(field(name)).onBlur({}));
}
const drawn = () => legendItems(builderRef.current.legend)[0];
const answer = (index = 0) => w.pending("PATCH", "/api/layers/a")[index];
/** A change made elsewhere arrives: the whole map, as an undo or the
 * assistant's resync applies it. */
async function changedElsewhere(layer: Record<string, unknown>) {
  await act(async () => builderRef.current.applyMapResponse({ ...initial, editRevision: "elsewhere",
    layers: [{ ...stored, ...layer }] } as unknown as MapWithLayers, false, Infinity));
}

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
  expect(drawn().attrs, "the legend and the editor disagree").toEqual({ fill: "Stored fill", radius: "Radius B" });
});

it("keeps a label typed since a refused save and shows the stored one where nothing was typed", async () => {
  await type(label(1), "One A");
  await leave(label(1));
  await type(label(2), "Two B");
  answer().refuse(400, "invalid_request", "legendLabels is not valid.");
  await settle();
  expect(field(label(1)).value).toBe("");
  expect(field(label(2)).value, "the editor dropped text typed since the refused save").toBe("Two B");
  expect(drawn().labels, "the legend and the editor disagree").toEqual([null, "Two B", null]);
});

it("keeps the title typed in an editor shown again while its earlier save is out, when that save is refused", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  await act(async () => shownRef.current(false));
  await act(async () => shownRef.current(true));
  await type(TITLE, "Title B");
  answer().refuse(400, "invalid_request", "legendTitle is too long.");
  await settle();
  expect(field(TITLE).value, "the editor dropped text typed since the refused save").toBe("Title B");
  expect(drawn().title).toBe("Title B");
});

it("keeps the title being typed when two queued variable-name saves are both refused", async () => {
  await type(FILL, "Fill A");
  await leave(FILL);
  await type(RADIUS, "Radius B");
  await leave(RADIUS);
  await type(TITLE, "Title C");
  answer().refuse(500, "internal", "The server failed.");
  await settle();
  expect(field(TITLE).value, "the first refusal dropped the title being typed").toBe("Title C");
  expect([field(FILL).value, field(RADIUS).value]).toEqual(["Stored fill", "Radius B"]);
  answer().refuse(500, "internal", "The server failed.");
  await settle();
  expect(field(TITLE).value, "the second refusal dropped the title being typed").toBe("Title C");
  expect(drawn().title).toBe("Title C");
  expect([field(FILL).value, field(RADIUS).value]).toEqual(["Stored fill", ""]);
  expect(drawn().attrs, "the legend and the editor disagree").toEqual({ fill: "Stored fill" });
  await leave(TITLE);
  expect(answer().body).toEqual({ legendTitle: "Title C" });
});

it("keeps the field being typed in when the legend is changed elsewhere, and saves it on leaving", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  answer().ok({ ...stored, legendTitle: "Title A", editRevision: "stored" });
  await settle();
  await type(TITLE, "Title B");
  await changedElsewhere({ legendTitle: "Elsewhere" });
  expect(field(TITLE).value, "another surface's change overwrote the text being typed").toBe("Title B");
  expect(drawn().title).toBe("Title B");
  await leave(TITLE);
  expect(answer().body).toEqual({ legendTitle: "Title B" });
  // The save builds on the change it was typed over: the revision sent is
  // the one that change brought, so the server judges it against that.
  expect(answer().headers.get("X-Edit-Revision")).toBe("elsewhere");
});

it("after a lost answer found stored, a change from elsewhere reaches every field but the one being typed in", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  answer().cut();
  await settle();
  w.pending("GET", "/api/maps/m")[0].ok({ ...initial, editRevision: "stored-a", layers: [{ ...stored, legendTitle: "Title A" }] });
  await settle();
  expect(field(TITLE).value).toBe("Title A");
  await type(TITLE, "Title B");
  await changedElsewhere({ legendTitle: "Elsewhere", legendAttrs: { fill: "Elsewhere fill" } });
  expect(field(TITLE).value, "another surface's change overwrote the text being typed").toBe("Title B");
  expect(drawn().title).toBe("Title B");
  expect(field(FILL).value, "a field not being typed in kept older text").toBe("Elsewhere fill");
  expect(drawn().attrs).toEqual({ fill: "Elsewhere fill" });
});

it("still sets every field to a change from elsewhere when nothing is being typed", async () => {
  await type(TITLE, "Title A");
  await leave(TITLE);
  answer().ok({ ...stored, legendTitle: "Title A", editRevision: "stored" });
  await settle();
  await changedElsewhere({ legendTitle: "Elsewhere", legendAttrs: { fill: "Elsewhere fill", radius: "Elsewhere radius" },
    legendLabels: ["Else one", null, "Else three"] });
  expect([field(TITLE).value, field(FILL).value, field(RADIUS).value]).toEqual(["Elsewhere", "Elsewhere fill", "Elsewhere radius"]);
  expect([field(label(1)).value, field(label(2)).value, field(label(3)).value]).toEqual(["Else one", "", "Else three"]);
  expect(drawn()).toMatchObject({ title: "Elsewhere", attrs: { fill: "Elsewhere fill", radius: "Elsewhere radius" },
    labels: ["Else one", null, "Else three"] });
});

it.each([
  { name: TITLE, change: { legendTitle: "Elsewhere" }, text: "Elsewhere", legend: { title: "Elsewhere" } },
  { name: FILL, change: { legendAttrs: { fill: "Elsewhere fill" } }, text: "Elsewhere fill", legend: { attrs: { fill: "Elsewhere fill" } } },
  { name: label(2), change: { legendLabels: [null, "Elsewhere two", null] }, text: "Elsewhere two", legend: { labels: [null, "Elsewhere two", null] } },
])("takes a change from elsewhere into the field with the caret where nothing was typed ($name)", async ({ name, change, text, legend }) => {
  field(name).focus();
  await changedElsewhere(change);
  expect(field(name).value, "a field showing stored text kept the older text").toBe(text);
  expect(drawn()).toMatchObject(legend);
  await leave(name);
  expect(w.pending("PATCH", "/api/layers/a"), "leaving the field put the older text back over the change").toEqual([]);
});

it.each([
  { name: TITLE, typed: "Title A", text: "Stored title", legend: { title: "Stored title" } },
  { name: FILL, typed: "Fill A", text: "Stored fill", legend: { attrs: { fill: "Stored fill" } } },
  { name: label(1), typed: "One A", text: "", legend: { labels: null } },
])("shows the stored text again in the field with the caret when its save is refused and nothing was typed since ($name)", async ({ name, typed, text, legend }) => {
  await type(name, typed);
  // The window loses focus: the field's leaving saves it, the caret stays.
  await act(async () => props(field(name)).onBlur({}));
  answer().refuse(400, "invalid_request", "The legend text is not valid.");
  await settle();
  expect(field(name).value, "the refused text stayed in the field").toBe(text);
  expect(drawn()).toMatchObject(legend);
  await leave(name);
  expect(w.pending("PATCH", "/api/layers/a"), "leaving the field sent the refused text again").toEqual([]);
});

it.each([
  { name: TITLE, how: "exactly", typed: "Typed title", back: "Stored title", change: { legendTitle: "Elsewhere" }, text: "Elsewhere", legend: { title: "Elsewhere" } },
  { name: TITLE, how: "but for trailing spaces", typed: "Typed title", back: "Stored title  ", change: { legendTitle: "Elsewhere" }, text: "Elsewhere", legend: { title: "Elsewhere" } },
  { name: FILL, how: "exactly", typed: "Typed fill", back: "Stored fill", change: { legendAttrs: { fill: "Elsewhere fill" } }, text: "Elsewhere fill", legend: { attrs: { fill: "Elsewhere fill" } } },
  { name: label(2), how: "exactly", typed: "Typed two", back: "", change: { legendLabels: [null, "Elsewhere two", null] }, text: "Elsewhere two", legend: { labels: [null, "Elsewhere two", null] } },
])("draws a change from elsewhere on the legend once the text typed in $name is erased back to the stored text $how", async ({ name, typed, back, change, text, legend }) => {
  await type(name, typed);
  await type(name, back);
  await changedElsewhere(change);
  await leave(name);
  expect(field(name).value).toBe(text);
  expect(drawn(), "the legend kept the erased keystrokes over the stored change").toMatchObject(legend);
  expect(builderRef.current.legendLive.a, "live text outlived the field it mirrored").toBeUndefined();
  expect(w.pending("PATCH", "/api/layers/a")).toEqual([]);
});

it.each([
  { name: TITLE, typed: "Typed title", back: "Stored title", change: { legendTitle: "Elsewhere" }, legend: { title: "Elsewhere" } },
  { name: FILL, typed: "Typed fill", back: "Stored fill", change: { legendAttrs: { fill: "Elsewhere fill" } }, legend: { attrs: { fill: "Elsewhere fill" } } },
  { name: label(2), typed: "Typed two", back: "", change: { legendLabels: [null, "Elsewhere two", null] }, legend: { labels: [null, "Elsewhere two", null] } },
])("draws a change from elsewhere on the legend after $name was typed, erased back and left unsaved", async ({ name, typed, back, change, legend }) => {
  await type(name, typed);
  await type(name, back);
  await leave(name);
  expect(w.pending("PATCH", "/api/layers/a")).toEqual([]);
  await changedElsewhere(change);
  expect(drawn(), "the legend kept the erased keystrokes over the stored change").toMatchObject(legend);
});

it("sets a field not being typed in to a change from elsewhere that left its own text alone", async () => {
  // Trailing spaces save as nothing new: the field keeps them, unsaved.
  await type(FILL, "Stored fill  ");
  await leave(FILL);
  expect(w.pending("PATCH", "/api/layers/a")).toEqual([]);
  await changedElsewhere({ legendTitle: "Elsewhere" });
  expect(field(TITLE).value).toBe("Elsewhere");
  expect(field(FILL).value, "only the pieces the change touched took the stored text").toBe("Stored fill");
});

import { afterEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { MapWidget } from "@/lib/widgets";
import { HookHarness, hookReact } from "../workflow-canvas/hook-harness";
import { wire } from "../workflow-canvas/fetch-wire";
vi.mock("react", () => hookReact);
import { useBuilderMutations } from "./use-builder-mutations";
import { useWidgetListActions } from "./use-widget-list-actions";
import { useBuilderWidgets } from "./use-builder-widgets";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
const note = (text: string): MapWidget => ({ id: text, type: "note", title: "Note", note: text, visible: true, layerId: null, field: null, agg: "count", aggField: null, unit: null, format: null });
function setup() {
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  let map = { id: "m", name: "Map", basemap: "dark", layers: [], widgets: [], editRevision: "seen" } as unknown as MapWithLayers;
  const setMap = (next: React.SetStateAction<MapWithLayers | null>) => { map = (typeof next === "function" ? next(map) : next)!; };
  const h = new HookHarness(() => {
    const editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef: { current: {} }, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    const widgets = useBuilderWidgets(map, null);
    const actions = useWidgetListActions({ ...editor, ...widgets, map, setMap, setTab() {}, setWidgetFocus() {} });
    return { ...editor, ...widgets, add: (text: string) => actions.apply([...map.widgets, note(text)]) };
  });
  cleanups.push(() => h.unmount());
  h.value.applyMapResponse(map, false, Infinity);
  const accept = async (text: string) => {
    h.render().add(text);
    await w.settle();
    const write = w.pending("PATCH", "/api/maps/m")[0];
    write.ok({ ...h.value.serverMapRef.current, ...write.body as object, editRevision: text });
    await h.value.sequence.idle();
    h.render();
  };
  return { w, h, accept, shown: () => map };
}

it.each(["cut", "unavailable", "truncated"] as const)("removes the outage card after a recovery read is %s without losing either accepted note", async failure => {
  const c = setup();
  await c.accept("first"); await c.accept("accepted");
  c.h.value.add("outage");
  await c.w.settle();
  c.w.pending("PATCH", "/api/maps/m")[0].cut(); await c.w.settle();
  const read = c.w.pending("GET", "/api/maps/m")[0];
  if (failure === "unavailable") read.refuse(503, "unavailable", "Unavailable");
  else read[failure]();
  await c.h.value.sequence.idle();
  expect(c.h.render().visibleWidgets.filter(widget => widget.note === "outage")).toHaveLength(0);
  expect(c.h.value.visibleWidgets.map(widget => widget.note)).toEqual(["first", "accepted"]);
  expect(c.h.value.serverMapRef.current?.widgets).toHaveLength(2);
  expect(c.h.value.sequence.revision).toBe("accepted");
  expect(c.h.value.failures.map).toContain("map save could not be confirmed");
  expect(c.w.calls.filter(call => call.method === "PATCH")).toHaveLength(3);
  // A later confirmed response must not resurrect the discarded card.
  const rename = c.h.value.patchMap({ name: "Renamed" });
  await c.w.settle();
  c.w.pending("PATCH", "/api/maps/m")[0].ok({ ...c.h.value.serverMapRef.current, name: "Renamed", editRevision: "renamed" });
  await rename;
  expect(c.h.render().visibleWidgets.map(widget => widget.note)).toEqual(["first", "accepted"]);
  expect(c.h.value.failures.map).toBeUndefined();
});

it("rolls back only the outage gesture while a later widget and name wait in the document sequence", async () => {
  const c = setup();
  await c.accept("first"); await c.accept("accepted");
  c.h.value.add("outage"); await c.w.settle();
  c.h.render().add("queued"); c.h.render();
  const rename = c.h.value.patchMap({ name: "Queued name" });
  c.w.pending("PATCH", "/api/maps/m")[0].cut(); await c.w.settle();
  c.w.pending("GET", "/api/maps/m")[0].cut(); await c.w.settle();
  expect(c.h.render().visibleWidgets.map(widget => widget.note)).toEqual(["first", "accepted", "queued"]);
  expect(c.shown().name).toBe("Queued name");
  expect(c.h.value.serverMapRef.current?.widgets).toHaveLength(2);
  expect(c.h.value.failures.map).toContain("could not be confirmed");
  const queued = c.w.pending("PATCH", "/api/maps/m")[0];
  expect(queued.body).toEqual({ widgets: [note("first"), note("accepted"), note("queued")] });
  expect(queued.headers.get("X-Edit-Revision")).toBe("accepted");
  queued.ok({ ...c.h.value.serverMapRef.current, ...queued.body as object, editRevision: "queued" });
  await c.w.settle();
  const named = c.w.pending("PATCH", "/api/maps/m")[0];
  expect(named.headers.get("X-Edit-Revision")).toBe("queued");
  named.ok({ ...c.h.value.serverMapRef.current, name: "Queued name", editRevision: "renamed" });
  await rename;
  expect(c.h.render().visibleWidgets.map(widget => widget.note)).toEqual(["first", "accepted", "queued"]);
});

it("keeps a stale refused note and subsequent intent visibly unsaved without attempting recovery", async () => {
  const c = setup();
  await c.accept("first"); await c.accept("accepted");
  c.h.value.add("outage"); await c.w.settle();
  c.h.render().add("queued");
  c.w.pending("PATCH", "/api/maps/m")[0].refuse(409, "stale_revision", "This item has changed. Reload it before trying again.");
  await c.h.value.sequence.idle();
  expect(c.h.render().visibleWidgets.map(widget => widget.note)).toEqual(["first", "accepted", "outage", "queued"]);
  expect(c.h.value.sequence.stale).toBe(true);
  expect(c.h.value.sequence.revision).toBe("accepted");
  expect(c.h.value.serverMapRef.current?.widgets).toHaveLength(2);
  expect(c.w.calls.filter(call => call.path === "/api/maps/m" && call.method === "GET")).toHaveLength(0);
  expect(c.w.calls.filter(call => call.method === "PATCH")).toHaveLength(3);
});

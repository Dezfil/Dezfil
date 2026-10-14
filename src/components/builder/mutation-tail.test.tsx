import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { MapWithLayers } from "@/lib/metadata/maps";
import type { MapWidget } from "@/lib/widgets";
import { HostElement, installDomHost } from "../testing/dom-host";
import { wire } from "../workflow-canvas/fetch-wire";
import { HeaderChrome } from "./BuilderChrome";
import { BasemapTab } from "./BasemapTab";
import { WidgetsTab } from "./WidgetsTab";
import { BuilderFailureNotes } from "./BuilderFailureNotes";
import { useBuilderMutations } from "./use-builder-mutations";
import { useBuilderCamera } from "./use-builder-camera";
import { useBuilderWidgets } from "./use-builder-widgets";
import { useWidgetListActions } from "./use-widget-list-actions";

vi.mock("next/navigation", () => ({ usePathname: () => "/maps/m" }));
vi.mock("./export/ExportControl", () => ({ ExportControl: () => null }));
vi.mock("./publish/PublishControl", () => ({ PublishControl: () => null }));
vi.mock("./assistant/AssistantDoor", () => ({ AssistantDoor: () => null }));
// Drag geometry needs a browser; the widget editor and save wiring stay real.
vi.mock("../widgets/SortableCards", () => ({ SortableCards: ({ ids, render }: { ids: string[]; render: (id: string, floating: boolean) => React.ReactNode }) => <>{ids.map(id => <div key={id}>{render(id, false)}</div>)}</> }));

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const note = (text: string): MapWidget => ({ id: text, type: "note", title: "Note", note: text, visible: true, layerId: null, field: null, agg: "count", aggField: null, unit: null, format: null });
const inputHandlers = (element: HostElement) => {
  const key = Object.keys(element).find(key => key.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void; onBlur: () => void }>)[key];
};

it("surfaces every map control failure, ignores held undo, and heals a silent camera failure without unhandled rejections", async () => {
  const host = installDomHost();
  vi.stubGlobal("HTMLElement", HostElement);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const errors: unknown[] = [];
  const unhandled = (error: unknown) => errors.push(error);
  process.on("unhandledRejection", unhandled);
  const consoleError = vi.spyOn(console, "error");
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  for (const id of ["header-crumb-slot", "header-actions-left", "header-actions-right"]) {
    const slot = host.document.createElement("span"); slot.setAttribute("id", id); host.document.body.appendChild(slot);
  }
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); process.off("unhandledRejection", unhandled); });
  // The preceding lost response accepted Dark; the outage left two notes.
  const initial = { id: "m", name: "Map", basemap: "dark", customBasemap: null, basemapLayers: null, layers: [], widgets: [note("first"), note("accepted")], widgetsPublished: true, editRevision: "accepted" } as unknown as MapWithLayers;
  const history = { canUndo: true, canRedo: false, editRevision: "accepted", undoTarget: { eligible: true, reason: null, steps: [] } };
  let editor!: ReturnType<typeof useBuilderMutations>;
  let camera!: ReturnType<typeof useBuilderCamera>;
  function Builder() {
    const [map, setMap] = useState<MapWithLayers | null>(initial);
    const [preview, setPreview] = useState<MapWidget | null>(null);
    const rendersRef = useRef({});
    const viewportRef = useRef(null);
    editor = useBuilderMutations({ mapId: "m", map, setMap, rendersRef, replaceRenders: async () => null, setSelectedId() {}, refreshLayer: async () => {} });
    camera = useBuilderCamera("m", viewportRef, editor.track);
    const widgets = useBuilderWidgets(map, preview);
    const actions = useWidgetListActions({ ...editor, ...widgets, map, setMap, setTab() {}, setWidgetFocus() {} });
    const { sequence, serverMapRef, setHistory } = editor;
    useEffect(() => { sequence.accept(initial); serverMapRef.current = initial; setHistory(history); }, [sequence, serverMapRef, setHistory]);
    return <>
      <HeaderChrome map={map!} projectId={null} history={editor.history} onUndo={() => void editor.applyHistory("undo")} onRedo={() => void editor.applyHistory("redo")}
        onRename={name => void editor.patchMap({ name })} assistant={{} as never} onPublishChange={() => {}} renders={{}} layerDataDownloads={{} as never} />
      <BuilderFailureNotes failures={editor.failures} clearFailure={editor.clearFailure} activeDownloads={[]} downloadFailures={[]} />
      <BasemapTab map={map!} loadedGroups={null} overridden={false} patchMap={editor.patchMap} statusPillVisible onToggleStatusPill={() => {}} />
      <WidgetsTab map={map!} onChange={actions.apply} onPreview={setPreview} onPublishedToggle={on => void editor.patchMap({ widgetsPublished: on })} />
      <output>{widgets.visibleWidgets.map(widget => widget.note).join(",")}</output>
    </>;
  }
  const flush = (work: () => void) => act(async () => { work(); await w.settle(); });
  await flush(() => root.render(<Builder />));
  const find = (selector: string) => host.document.querySelector(selector)!;
  const button = (text: string) => host.document.querySelectorAll("button").find(element => element.textContent === text)!;
  const banner = () => host.document.querySelector('[data-map-error][data-lane="map"]');

  const controls: [string, () => Promise<void>][] = [
    ["rename", async () => {
      await flush(() => find('[title="Rename Map"]').click());
      await flush(() => inputHandlers(find('[aria-label="Map name"]')).onChange({ target: { value: "Renamed" } }));
      await flush(() => inputHandlers(find('[aria-label="Map name"]')).onBlur());
    }],
    ["basemap", async () => {
      expect(button("Dark").getAttribute("data-active")).toBe("true");
      await flush(() => button("Dark").click());
    }],
    ["widgets", async () => {
      await flush(() => find("[data-add-widget-row]").click());
      await flush(() => find('[data-add-type="note"]').click());
      await flush(() => inputHandlers(find("textarea")).onChange({ target: { value: "x" } }));
      await flush(() => button("Add note").click());
    }],
  ];
  for (const [name, change] of controls) {
    await change();
    expect(w.pending("PATCH", "/api/maps/m"), name).toHaveLength(1);
    await flush(() => w.pending("PATCH", "/api/maps/m")[0].cut());
    expect(banner()?.textContent, name).toContain("map save could not be confirmed");
    await flush(() => w.pending("GET", "/api/maps/m")[0].ok(initial));
    await flush(() => {
      for (const read of w.pending("GET", "/api/maps/m/history")) read.ok(history);
    });
    expect(editor.sequence.revision).toBe("accepted");
    expect(find("output").textContent).toBe("first,accepted");
    await flush(() => banner()!.querySelector('[aria-label="Dismiss"]')!.click());
    expect(banner()).toBeNull();
  }

  const key = (repeat: boolean) => host.window.dispatchEvent({ type: "keydown", key: "z", ctrlKey: true, repeat, target: null, preventDefault() {} } as unknown as { type: string });
  await flush(() => { for (let i = 0; i < 6; i++) key(i > 0); });
  expect(w.pending("POST", "/api/maps/m/undo")).toHaveLength(1);
  // Even after the first step settles, a held chord is still one press.
  await flush(() => w.pending("POST", "/api/maps/m/undo")[0].ok({ ...initial, editRevision: "undone", history: { ...history, editRevision: "undone" } }));
  await flush(() => key(true));
  expect(w.calls.filter(call => /\/(undo|redo)$/.test(call.path))).toHaveLength(1);
  expect(editor.sequence.revision).toBe("undone");

  const first = { lng: 13, lat: 52, zoom: 12 };
  const next = { ...first, lng: 13.1 };
  await flush(() => camera(first));
  const lost = w.pending("PATCH", "/api/maps/m")[0];
  expect(lost.body).toEqual({ viewport: first });
  expect(lost.headers.has("X-Edit-Revision")).toBe(false);
  await flush(() => lost.cut());
  expect(host.document.querySelectorAll("[data-map-error]")).toHaveLength(0);
  expect(editor.pendingSaves).toBe(0);
  await flush(() => camera(next));
  expect(w.pending("PATCH", "/api/maps/m")).toHaveLength(1);
  const repaired = w.pending("PATCH", "/api/maps/m")[0];
  expect(repaired.body).toEqual({ viewport: next });
  await flush(() => repaired.ok({ ...initial, viewport: next }));
  expect(editor.pendingSaves).toBe(0);
  expect(editor.sequence.revision).toBe("undone");
  expect(host.document.querySelectorAll("[data-map-error]")).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
});

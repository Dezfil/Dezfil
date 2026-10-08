import { act, useEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceDefaults } from "@/lib/settings/defaults";
import { installDomHost } from "../testing/dom-host";
import { ScreenDefaultsProvider } from "../screen-defaults";
import { WorkflowScreen } from "../WorkflowScreen";
import { WorkflowCanvas } from "./WorkflowCanvas";
import type { WorkflowStage } from "./WorkflowStage";
import type { PageRead } from "./workflow-read";
import { readWorkflowPage } from "./workflow-read";
import { wire } from "./fetch-wire";

/**
 * A workflow canvas opens as the instance's defaults say: full screen or
 * framed, and with the minimap by the instance's rule until the viewer
 * chose in this browser, whose choice always wins. The defaults are taken
 * as the canvas opens: a page that hands down others later leaves an open
 * canvas as it was. The canvas is mounted through its screen, as its page
 * mounts it.
 */

const probe = vi.hoisted(() => ({ stage: null as null | { minimapShown?: boolean; onMinimap?: () => void } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workflows/w" }));
vi.mock("next/dynamic", () => ({ default: () => function Canvas(props: ComponentProps<typeof WorkflowCanvas>) { return <WorkflowCanvas {...props} />; } }));
vi.mock("./workflow-read", async importOriginal => ({ ...await importOriginal<typeof import("./workflow-read")>(), readWorkflowPage: vi.fn() }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./WorkflowAssistantHost", () => ({ useWorkflowAssistant: () => ({ open: false, band: "two" }) }));
vi.mock("./CanvasFurniture", async importOriginal => ({ ...await importOriginal<typeof import("./CanvasFurniture")>(), CanvasFurniture: () => null }));
vi.mock("./CanvasPane", () => ({ CanvasPane: () => null }));
vi.mock("./CanvasStage", () => ({
  CanvasStage: (props: { minimapShown?: boolean; onMinimap?: () => void }) => {
    probe.stage = props;
    return null;
  },
}));
vi.mock("./CanvasResults", () => ({ CanvasResults: () => null }));
vi.mock("./CanvasGrid", () => ({ CanvasGrid: () => null }));
vi.mock("./CanvasMinimap", () => ({ CanvasMinimap: () => <div data-minimap-probe /> }));
vi.mock("@xyflow/react", async importOriginal => {
  const flow = await importOriginal<typeof import("@xyflow/react")>();
  const updateNodeInternals = () => {};
  return {
    ...flow,
    useUpdateNodeInternals: () => updateNodeInternals,
    // The real store and hooks, without browser geometry or gestures.
    ReactFlow: function FlowHost({ nodes, children }: ComponentProps<typeof WorkflowStage>) {
      const store = flow.useStoreApi();
      useEffect(() => { if (nodes) store.getState().setNodes(nodes); }, [nodes, store]);
      return <div data-flow-host>{children}</div>;
    },
  };
});

const PRODUCT = {
  "newMap.basemap": null, "newMap.latitude": 40, "newMap.longitude": 0, "newMap.zoom": 1.3, "newMap.legendCorner": null,
  "newLayer.colorCycle": "uber_viz_qualitative", "newLayer.pointOpacity": 72, "newLayer.lineOpacity": 95,
  "newLayer.areaOpacity": 50, "newLayer.lineWidth": 2, "newLayer.pointRadius": 3,
  "canvas.opens": "full", "canvas.minimap": "auto", "canvas.resultsBand": "closed",
  "sqlConsole.textSize": "12", "sqlConsole.lineWrap": false, "imageExport.width": "1920", "imageExport.shape": "4:3",
} as const satisfies InstanceDefaults;
const canvasDefaults = (opens: "full" | "framed", minimap: "auto" | "always" | "never"): InstanceDefaults =>
  ({ ...PRODUCT, "canvas.opens": opens, "canvas.minimap": minimap });

const MINIMAP_KEY = "dezfil.workflow.minimap";

/** A workflow of `count` nodes reading nothing, so every member is a node. */
const pageOf = (count: number): PageRead => ({
  recipe: { id: "w", name: "Opening", editRevision: "saved", projectId: null,
    origin: "workflow", createdAt: "now", updatedAt: "now", summary: { nodes: count, sources: 0, liveOutputs: 0, status: "never_run", count },
    steps: Array.from({ length: count }, (_, ordinal) => ({
      id: `s${ordinal}`, ordinal, operation: "sql_step", parameters: { sql: "SELECT 1", name: `s${ordinal}` }, proposedParameters: null,
      output: null, reads: [], condition: "never_run", conditions: ["never_run"], causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null,
    })) },
  layout: { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "saved" },
  tables: [], operations: [],
});

/** The browser's storage, kept in memory. */
function memoryStorage(entries: Record<string, string>) {
  const kept = new Map(Object.entries(entries));
  return {
    kept,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, String(value)),
    removeItem: (key: string) => void kept.delete(key),
    key: (index: number) => [...kept.keys()][index] ?? null,
    get length() { return kept.size; },
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  probe.stage = null;
});

/** Opens a workflow of `count` nodes under the defaults a page handed down
 * (none: no provider at all), with what this browser already keeps. */
async function open(defaults: InstanceDefaults | null, count: number, stored: Record<string, string> = {}) {
  cleanups.splice(0).forEach(cleanup => cleanup());
  const host = installDomHost();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const storage = memoryStorage(stored);
  vi.stubGlobal("localStorage", storage);
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const actions = host.document.createElement("div"); actions.setAttribute("id", "header-actions-right"); host.document.body.appendChild(actions);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  vi.mocked(readWorkflowPage).mockResolvedValue(pageOf(count));
  vi.stubGlobal("fetch", wire().fetch);
  const render = async (handed: InstanceDefaults | null) => act(async () => {
    root.render(handed ? <ScreenDefaultsProvider defaults={handed}><WorkflowScreen id="w" /></ScreenDefaultsProvider> : <WorkflowScreen id="w" />);
    await setImmediate();
  });
  await render(defaults);
  const seen = () => ({
    view: host.document.querySelector("[data-workflow-canvas]")?.getAttribute("data-view") ?? null,
    minimap: host.document.querySelectorAll("[data-minimap-probe]").length === 1,
    button: probe.stage?.minimapShown ?? null,
  });
  return { render, seen, storage };
}

describe("a workflow canvas", () => {
  it("opens full screen or framed as the instance's default says, full screen with none handed down", async () => {
    expect((await open(canvasDefaults("framed", "auto"), 2)).seen().view).toBe("framed");
    expect((await open(canvasDefaults("full", "auto"), 2)).seen().view).toBe("full");
    expect((await open(null, 2)).seen().view).toBe("full");
  });

  it.each([
    ["auto", 5, false],
    ["auto", 6, true],
    ["always", 2, true],
    ["never", 6, false],
  ] as const)("shows the minimap by the rule %s at %i nodes while the viewer never chose: %s", async (rule, count, shown) => {
    const { seen } = await open(canvasDefaults("full", rule), count);
    expect(seen()).toMatchObject({ minimap: shown, button: shown });
  });

  it("shows the viewer's own choice in this browser whatever the rule", async () => {
    expect((await open(canvasDefaults("full", "always"), 6, { [MINIMAP_KEY]: "hidden" })).seen()).toMatchObject({ minimap: false, button: false });
    expect((await open(canvasDefaults("full", "never"), 2, { [MINIMAP_KEY]: "shown" })).seen()).toMatchObject({ minimap: true, button: true });
  });

  it("keeps the viewer's press of the stage button as their choice", async () => {
    const { seen, storage } = await open(canvasDefaults("full", "never"), 6);
    expect(seen().minimap).toBe(false);
    expect(storage.kept.has(MINIMAP_KEY)).toBe(false);
    await act(async () => probe.stage!.onMinimap!());
    expect(seen()).toMatchObject({ minimap: true, button: true });
    expect(storage.kept.get(MINIMAP_KEY)).toBe("shown");
  });

  it("stays as it opened when the page hands down other defaults while it is open", async () => {
    const { render, seen } = await open(canvasDefaults("framed", "never"), 6);
    expect(seen()).toMatchObject({ view: "framed", minimap: false });
    await render(canvasDefaults("full", "always"));
    expect(seen()).toMatchObject({ view: "framed", minimap: false, button: false });
  });
});

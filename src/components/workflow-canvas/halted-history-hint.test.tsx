import { act, useEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { installDomHost } from "../testing/dom-host";
import { WorkflowScreen } from "../WorkflowScreen";
import { WorkflowCanvas } from "./WorkflowCanvas";
import type { WorkflowStage } from "./WorkflowStage";
import { readWorkflowPage, type PageRead } from "./workflow-read";
import { wire } from "./fetch-wire";

/**
 * Undo and Redo in the workflow's header say why they are closed once the
 * workflow's writes have halted, in the halted status's own words: after
 * access has ended, that the person can no longer edit; after a stale
 * revision, that the item has changed. The canvas is mounted through its
 * screen, as its page mounts it.
 */

const probe = vi.hoisted(() => ({ canvas: null as null | ComponentProps<typeof WorkflowCanvas> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workflows/w" }));
vi.mock("next/dynamic", () => ({ default: () => function Canvas(props: ComponentProps<typeof WorkflowCanvas>) {
  probe.canvas = props;
  return <WorkflowCanvas {...props} />;
} }));
vi.mock("./workflow-read", async importOriginal => ({ ...await importOriginal<typeof import("./workflow-read")>(), readWorkflowPage: vi.fn() }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./WorkflowAssistantHost", () => ({ useWorkflowAssistant: () => ({ open: false, band: "two" }), WorkflowAssistantDoor: () => null }));
vi.mock("./CanvasFurniture", async importOriginal => ({ ...await importOriginal<typeof import("./CanvasFurniture")>(), CanvasFurniture: () => null }));
vi.mock("./CanvasPane", () => ({ CanvasPane: () => null }));
vi.mock("./CanvasStage", () => ({ CanvasStage: () => null }));
vi.mock("./CanvasResults", () => ({ CanvasResults: () => null }));
vi.mock("./CanvasGrid", () => ({ CanvasGrid: () => null }));
vi.mock("./CanvasMinimap", () => ({ CanvasMinimap: () => null }));
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

const SAYS_ENDED = "You can no longer edit this item. Reload the page to continue.";
const SAYS_STALE = "This item has changed. Reload it before trying again.";
const HALTS = [
  ["access ended (no longer reached)", 404, "not_found", "The requested resource was not found.", SAYS_ENDED],
  ["access ended (no longer theirs to change)", 403, "forbidden", "You can view this but cannot make this change.", SAYS_ENDED],
  ["a stale revision", 409, "stale_revision", SAYS_STALE, SAYS_STALE],
] as const;

const page: PageRead = {
  recipe: { id: "w", name: "Halting", editRevision: "seen", projectId: null, origin: "workflow", createdAt: "now", updatedAt: "now",
    summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "never_run", count: 1 },
    steps: [{ id: "n", ordinal: 0, operation: "sql_step", parameters: { sql: "SELECT 1", name: "n" }, proposedParameters: null,
      output: null, reads: [], condition: "never_run", conditions: ["never_run"], causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null }] },
  layout: { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "seen" },
  tables: [], operations: [],
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  probe.canvas = null;
});

it.each(HALTS)("closes Undo and Redo in the halted status's words after %s", async (_name, status, code, message, says) => {
  const host = installDomHost();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const slot = host.document.createElement("div"); slot.setAttribute("id", "header-actions-left"); host.document.body.appendChild(slot);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  vi.mocked(readWorkflowPage).mockResolvedValue(page);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const flush = async (work: () => unknown) => act(async () => { await work(); await setImmediate(); });
  await flush(() => root.render(<WorkflowScreen id="w" />));
  const named = (selector: string) => host.document.querySelector(selector)?.getAttribute("aria-label");
  expect(named("[data-undo]")).toBe("Undo");
  const document = probe.canvas!.edits.document!;
  let edit!: Promise<Response>;
  await flush(() => { edit = document.request("/api/recipes/w/steps/n", { method: "PATCH", body: "{}" }); });
  await flush(async () => { w.pending("PATCH", "/api/recipes/w/steps/n")[0].refuse(status, code, message); await edit; });
  expect(document.stale).toBe(true);
  expect(named("[data-undo]")).toBe(`Undo: ${says}`);
  expect(named("[data-redo]")).toBe(`Redo: ${says}`);
});

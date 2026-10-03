import { act, useEffect, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { installDomHost } from "../testing/dom-host";
import { WorkflowScreen } from "../WorkflowScreen";
import { WorkflowCanvas } from "./WorkflowCanvas";
import type { WorkflowStage } from "./WorkflowStage";
import type { PageRead } from "./workflow-read";
import { readWorkflowPage } from "./workflow-read";
import type { WorkflowRun } from "./run-overlay";
import { wire } from "./fetch-wire";

const probe = vi.hoisted(() => ({ renders: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workflows/w" }));
vi.mock("next/dynamic", () => ({ default: () => function Canvas(props: ComponentProps<typeof WorkflowCanvas>) { return <WorkflowCanvas {...props} />; } }));
vi.mock("./workflow-read", async importOriginal => ({ ...await importOriginal<typeof import("./workflow-read")>(), readWorkflowPage: vi.fn() }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./WorkflowAssistantHost", () => ({ useWorkflowAssistant: () => ({ open: false, band: "two" }) }));
vi.mock("./CanvasFurniture", async importOriginal => ({ ...await importOriginal<typeof import("./CanvasFurniture")>(), CanvasFurniture: () => null }));
vi.mock("./CanvasPane", () => ({ CanvasPane: () => null }));
vi.mock("./CanvasStage", () => ({ CanvasStage: () => null }));
vi.mock("./CanvasResults", () => ({ CanvasResults: () => null }));
vi.mock("./CanvasGrid", () => ({ CanvasGrid: () => null }));
vi.mock("@xyflow/react", async importOriginal => {
  const flow = await importOriginal<typeof import("@xyflow/react")>();
  const updateNodeInternals = () => {};
  return {
    ...flow,
    useUpdateNodeInternals: () => updateNodeInternals,
    // Keep the real store and hooks, but omit browser geometry and gestures.
    // Like ReactFlow's StoreUpdater, changed node props update the store.
    ReactFlow: function FlowHost({ nodes, children }: ComponentProps<typeof WorkflowStage>) {
      const store = flow.useStoreApi();
      useEffect(() => { if (nodes) store.getState().setNodes(nodes); }, [nodes, store]);
      if (++probe.renders > 40) throw new Error("Canvas renders did not settle after run progress");
      return <div data-flow-host>{nodes?.map(node => <span key={node.id} data-flow-node={node.id}>
        {"member" in node.data && node.data.member.kind === "node" ? node.data.member.state.word : "source or note"}
      </span>)}{children}</div>;
    },
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("settles the mounted canvas and updates its dock when an observed run reports progress", async () => {
  vi.useFakeTimers();
  const host = installDomHost();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("localStorage", { getItem: () => null });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const actions = host.document.createElement("div"); actions.setAttribute("id", "header-actions-right"); host.document.body.appendChild(actions);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const page: PageRead = {
    recipe: { id: "w", name: "Progress", editRevision: "saved", projectId: null,
      origin: "workflow", createdAt: "now", updatedAt: "now", summary: { nodes: 2, sources: 0, liveOutputs: 0, status: "never_run", count: 2 },
      steps: ["a", "b"].map((id, ordinal) => ({
      id, ordinal, operation: "sql_step", parameters: { sql: "SELECT 1", name: id }, proposedParameters: null,
      output: null, reads: [], condition: "never_run", conditions: ["never_run"], causes: [], missingInputs: [], inputs: [], latestAttempt: null, lastSuccessAt: null,
    })) },
    layout: { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "saved" },
    tables: [], operations: [],
  };
  vi.mocked(readWorkflowPage).mockResolvedValue(page);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
  const settled = () => {
    expect(probe.renders).toBeGreaterThan(0);
    expect(probe.renders).toBeLessThan(20);
    expect(errors.mock.calls).toEqual([]);
    probe.renders = 0;
  };
  probe.renders = 0;
  await flush(() => root.render(<WorkflowScreen id="w" />));
  settled();
  const run: WorkflowRun = {
    id: "r", recipeId: "w", kind: "run_all", outcome: null, cancelled: false, startedAt: "now", finishedAt: null,
    members: ["a", "b"].map((stepId, ordinal) => ({ stepId, ordinal, operation: "sql_step", name: stepId,
      state: "pending", jobId: null, stoppedBy: null, stoppedReason: null, output: null, attempt: null })),
  };
  await flush(() => w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [run] }));
  settled();
  expect(host.document.querySelector('[data-run-dock="running"]')?.textContent).toBe("running · 0 of 2 nodes");
  expect(host.document.querySelector('[data-flow-node="a"]')?.textContent).toBe("waiting");
  const progress: WorkflowRun = { ...run, members: run.members.map((member, i) => ({ ...member, state: i === 0 ? "succeeded" : "running" })) };
  await flush(() => w.pending("GET", "/api/recipes/w/runs/r")[0].ok({ run: progress }));
  settled();
  expect(host.document.querySelector('[data-run-dock="running"]')?.textContent).toBe("running · 1 of 2 nodes");
  expect(host.document.querySelector('[data-flow-node="a"]')?.textContent).toBe("up to date");
  expect(host.document.querySelector('[data-flow-node="b"]')?.textContent).toBe("running");
  const refresh = () => {
    w.pending("GET", "/api/recipes/w")[0].ok({ recipe: page.recipe });
    w.pending("GET", "/api/tables")[0].ok([]);
  };
  await flush(refresh);
  settled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const ended: WorkflowRun = { ...progress, outcome: "completed", finishedAt: "later", members: progress.members.map(member => ({ ...member, state: "succeeded" })) };
  await flush(() => w.pending("GET", "/api/recipes/w/runs/r")[0].ok({ run: ended }));
  settled();
  await flush(refresh);
  settled();
  expect(host.document.querySelector('[data-run-dock="ended"]')?.textContent).toBe("Completed · 2 nodes");
  await flush(() => w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [ended] }));
  settled();
  expect(vi.getTimerCount()).toBe(0);
});

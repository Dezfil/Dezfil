import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { WorkflowScreen } from "../WorkflowScreen";
import type { WorkflowCanvas } from "./WorkflowCanvas";
import { CanvasSaveStatus } from "./CanvasSaveStatus";
import { readWorkflowPage, type PageRead } from "./workflow-read";
import { wire } from "./fetch-wire";
import { STALE_MESSAGE } from "../document-sequence";
import { LayoutSaveCoordinator } from "./layout-save-coordinator";
import { readRecipe, runInverse } from "./history-operation";
import { EMPTY_HISTORY, type History, type RecipeStep } from "./canvas-history";
import type { WorkflowStep } from "../workflow-model";

let canvas: ComponentProps<typeof WorkflowCanvas>;
vi.mock("next/navigation", () => ({ usePathname: () => "/workflows/w" }));
vi.mock("next/dynamic", () => ({ default: () => function Canvas(props: ComponentProps<typeof WorkflowCanvas>) {
  canvas = props;
  return <CanvasSaveStatus whisper={props.whisper ?? null} />;
} }));
vi.mock("./workflow-read", async original => ({ ...await original<typeof import("./workflow-read")>(), readWorkflowPage: vi.fn() }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./WorkflowAssistantHost", () => ({ useWorkflowAssistant: () => ({ open: false, band: "two" }) }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("saves after a lost restoration response and keeps a new failure's Retry past the accepted save's fade", async () => {
  vi.useFakeTimers();
  const host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const node = { id: "buf", ordinal: 0, operation: "buffer", parameters: { name: "buffer", distance: 100 }, proposedParameters: null,
    output: null, lastSuccessAt: null, conditions: ["never_run"], inputs: [], reads: [], missingInputs: [], causes: [] } as unknown as WorkflowStep;
  const page: PageRead = {
    recipe: { id: "w", name: "Workflow", editRevision: "seen", projectId: null, origin: "workflow", createdAt: "now", updatedAt: "now",
      summary: { nodes: 1, sources: 0, liveOutputs: 0, status: "never_run", count: 1 }, steps: [node] },
    layout: { steps: { buf: { x: 288, y: 40 } }, sources: {}, notes: [], updatedAt: null, editRevision: "seen" }, tables: [], operations: [],
  };
  vi.mocked(readWorkflowPage).mockResolvedValue(page);
  let storedRecipe = page.recipe, storedLayout = page.layout;
  let cutLayout = false;
  const w = wire();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    if (method === "GET") {
      if (path === "/api/recipes/w") return Response.json({ recipe: storedRecipe });
      if (path === "/api/recipes/w/layout") return Response.json({ layout: storedLayout });
      if (path === "/api/recipes/w/runs") return Response.json({ runs: [] });
    }
    if (method === "PUT" && path === "/api/recipes/w/layout") {
      if (cutLayout) throw new TypeError("Failed to fetch");
      if (new Headers(init?.headers).get("X-Edit-Revision") !== storedRecipe.editRevision) {
        return Response.json({ error: { code: "stale_revision", message: STALE_MESSAGE } }, { status: 409 });
      }
      const editRevision = `${storedRecipe.editRevision}-layout`;
      storedRecipe = { ...storedRecipe, editRevision };
      storedLayout = { ...JSON.parse(String(init?.body)), editRevision };
      return Response.json({ layout: storedLayout, editRevision });
    }
    return w.fetch(input, init);
  });
  const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
  await flush(() => root.render(<WorkflowScreen id="w" />));
  const saves = new LayoutSaveCoordinator("w", page.layout, { graph: canvas.graph, onState: state => canvas.onSaveState!(state), lockReason: () => null, say() {} }, canvas.edits.document);
  const removed: RecipeStep = { kind: "recipe", nodeId: "old", watermarks: { old: null }, label: "SQL step removed",
    op: { kind: "remove", operation: "sql", parameters: { name: "after", sql: "SELECT 1" }, ordinal: 1, dataset: "never", position: { x: 576, y: 40 } } };
  let history: History = { ...EMPTY_HISTORY, past: [removed] };
  let inverse!: Promise<void>;
  await flush(() => {
    inverse = runInverse(removed, "undo", {
      edits: canvas.edits, read: () => readRecipe("w"), record: () => history, put: next => { history = next; }, labelOf: id => id,
      answered() {}, forget() {}, enqueue: job => { inverse = job(); },
      screen: () => ({ lockReason: null, say() {}, runWord: () => null, stored: () => storedLayout.steps, dropNode() {},
        failed: (message, retry) => canvas.onEditState!({ kind: "failed", message, retry }), recovered: () => canvas.onEditState!({ kind: "saved" }),
        placeNode: (id, position) => saves.save({ positions: { ...storedLayout.steps, [id]: position }, notes: [] }) }),
    });
  });
  // The POST landed, but the browser did not get its revision. Retry must
  // adopt this one node without leaving the next layout on an old basis.
  storedRecipe = { ...storedRecipe, editRevision: "restored", steps: [node, { ...node, id: "new", ordinal: 1, operation: "sql", parameters: { name: "after", sql: "SELECT 1" } }] };
  storedLayout = { ...storedLayout, editRevision: "restored" };
  await flush(() => w.pending("POST", "/api/recipes/w/steps")[0].cut());
  await inverse;
  const line = () => host.document.querySelector('[data-save-status="whisper"]');
  expect(line()?.textContent).toBe("Couldn’t saveRetry");
  await flush(() => line()!.querySelector("button")!.click());
  await act(async () => { await inverse; await canvas.edits.idle(); });
  const start = { ...storedLayout.steps };
  await flush(() => saves.save({ positions: { ...start, buf: { x: 328, y: 64 } }, notes: [] }));
  expect(line()?.textContent).toBe("Saved");
  expect(w.calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(storedRecipe.steps.map(step => step.id)).toEqual(["buf", "new"]);
  expect(canvas.edits.document!.stale).toBe(false);

  cutLayout = true;
  await flush(() => saves.save({ positions: start, notes: [] }));
  expect(line()?.textContent).toBe("Couldn’t saveRetry");
  await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
  expect(line()?.textContent).toBe("Couldn’t saveRetry");
  expect(line()!.getAttribute("data-on")).toBe("true");
  cutLayout = false;
  await flush(() => line()!.querySelector("button")!.click());
  expect(line()?.textContent).toBe("Saved");
  expect(storedLayout.steps).toEqual(start);
});
function inputHandlers(element: HostElement) {
  const key = Object.keys(element).find(key => key.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, unknown>)[key] as {
    onChange: (event: { target: { value: string } }) => void;
    onBlur: () => void;
  };
}

it.each(["saved", "refused", "stale"] as const)("a queued rename leaves Saving after its %s response, with the chip on", async outcome => {
  vi.useFakeTimers();
  const host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  const container = host.document.createElement("div"); host.document.body.appendChild(container);
  const crumb = host.document.createElement("div"); crumb.setAttribute("id", "header-crumb-slot"); host.document.body.appendChild(crumb);
  const root = createRoot(container as unknown as Element);
  cleanups.push(() => { act(() => root.unmount()); host.uninstall(); });
  const page: PageRead = {
    recipe: { id: "w", name: "Workflow", editRevision: "seen", projectId: null, origin: "workflow", createdAt: "now", updatedAt: "now",
      summary: { nodes: 0, sources: 0, liveOutputs: 0, status: "never_run", count: 0 }, steps: [] },
    layout: { steps: {}, sources: {}, notes: [], updatedAt: null, editRevision: "seen" }, tables: [], operations: [],
  };
  vi.mocked(readWorkflowPage).mockResolvedValue(page);
  const w = wire(); vi.stubGlobal("fetch", w.fetch);
  const flush = async (work: () => void) => act(async () => { work(); await setImmediate(); });
  await flush(() => root.render(<WorkflowScreen id="w" />));
  await flush(() => w.pending("GET", "/api/recipes/w/runs")[0].ok({ runs: [] }));
  const line = () => host.document.querySelector('[data-save-status="whisper"]')!;
  // Keep the real ordered document request ahead of the rename.
  let preceding!: Promise<Response>;
  await flush(() => {
    preceding = canvas.edits.document!.request("/api/recipes/w/layout", { method: "PUT", body: JSON.stringify(page.layout) });
  });
  await flush(() => crumb.querySelector("button")!.click());
  const input = () => crumb.querySelector("input")!;
  await flush(() => inputHandlers(input()).onChange({ target: { value: "Renamed" } }));
  await flush(() => inputHandlers(input()).onBlur());
  expect(line().getAttribute("data-on")).toBe("true");
  expect(line().textContent).toBe("Saving…");
  expect(w.pending("PATCH", "/api/recipes/w")).toHaveLength(0);
  await flush(() => w.pending("PUT", "/api/recipes/w/layout")[0].ok({ layout: { ...page.layout, editRevision: "layout" }, editRevision: "layout" }));
  await preceding;
  const rename = w.pending("PATCH", "/api/recipes/w")[0];
  expect(rename.headers.get("X-Edit-Revision")).toBe("layout");
  const sentence = outcome === "saved" ? "Saved" : outcome === "stale" ? STALE_MESSAGE : "The name could not be filed.";
  await flush(() => {
    if (outcome === "saved") rename.ok({ recipe: { ...page.recipe, name: "Renamed", editRevision: "renamed" }, editRevision: "renamed" });
    else rename.refuse(outcome === "stale" ? 409 : 500, outcome === "stale" ? "stale_revision" : "internal", sentence);
  });
  const settled = outcome === "stale" ? host.document.querySelector('[data-save-status="stale"]')! : line();
  expect(settled.getAttribute("data-on")).toBe("true");
  expect(settled.textContent).toBe(outcome === "stale" ? `${sentence}Reload` : sentence);
  expect(container.textContent).not.toContain("Saving…");
  if (outcome === "refused") {
    // Even a late producer notification cannot overwrite another owner's
    // standing refusal. No concurrent document writes are needed to test it.
    await flush(() => canvas.onSaveState!({ kind: "saved" }));
    expect(line().getAttribute("data-on")).toBe("true");
    expect(line().textContent).toBe(sentence);
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(line().textContent).toBe(sentence);
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  if (outcome === "stale") expect(settled.getAttribute("data-on")).toBe("true");
  else expect(line().getAttribute("data-on")).toBeNull();
  expect(container.textContent).not.toContain("Saving…");
});

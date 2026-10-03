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

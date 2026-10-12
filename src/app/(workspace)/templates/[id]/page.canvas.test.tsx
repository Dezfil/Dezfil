import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { installDomHost, type HostElement } from "@/components/testing/dom-host";
import type { WorkflowCanvas } from "@/components/workflow-canvas/WorkflowCanvas";
import type { WorkflowStage } from "@/components/workflow-canvas/WorkflowStage";
import { OPERATIONS } from "@/lib/operations/catalog";
import { writeStoredSettings } from "@/lib/settings/store";
import { resetCatalogueForTests } from "@/lib/templates/catalogue";
import * as shippedIndex from "@/lib/templates/shipped-index";
import { testAccountRequest } from "@/lib/test-support/accounts";
import { instanceSettingsFixture } from "../../../../../test-support/instance-settings";
import { buildTemplate, installFixture, writeShippedFolder, type BuiltTemplate } from "../../../../../test-support/templates/builder";
import TemplatePage from "./page";

/**
 * A workflow example's own address, drawn as the page serves it: the
 * page's element, with whatever it wraps the view in, mounted over the
 * real workflow screen, canvas and canvas furniture. Only what needs a
 * browser's layout is a stand-in: the flow library's host, which draws
 * one mark per node, and the header's measure of the panel. The server
 * answers through fetch: the operation catalog and the template map.
 *
 * The page hands the canvas the instance's defaults as a workflow's page
 * does, so it opens as the instance says a canvas opens.
 *
 * The view's own tests stand the canvas's furniture and the assistant's
 * host in for stubs, so a part of the canvas that needs a provider the
 * template page does not mount cannot fail there; here it does.
 */

const who = vi.hoisted(() => ({ account: "member", db: null as unknown }));
vi.mock("next/headers", () => ({
  headers: async () => testAccountRequest(new Request("http://instance.test/templates/busy-stations"),
    who.db as import("better-sqlite3").Database, who.account).headers,
}));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => "/templates/busy-stations",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
// The panel measures itself for the header card: the host computes no layout.
vi.mock("@/components/shell/use-header-reach", () => ({ useHeaderReach: () => {} }));
// The canvas as the workflow page mounts it, the library loaded at once.
vi.mock("next/dynamic", async () => {
  const { WorkflowCanvas: Canvas } = await import("@/components/workflow-canvas/WorkflowCanvas");
  return { default: () => function Loaded(props: ComponentProps<typeof WorkflowCanvas>) { return <Canvas {...props} />; } };
});
// The flow library's host lays nodes out in a browser: here it keeps them
// in its store and draws a mark per node.
vi.mock("@xyflow/react", async (original) => {
  const flow = await original<typeof import("@xyflow/react")>();
  const updateNodeInternals = () => {};
  return {
    ...flow,
    useUpdateNodeInternals: () => updateNodeInternals,
    ReactFlow: function FlowHost({ nodes, children }: ComponentProps<typeof WorkflowStage>) {
      const store = flow.useStoreApi();
      useEffect(() => { if (nodes) store.getState().setNodes(nodes); }, [nodes, store]);
      return <div data-flow-host>{nodes?.map((node) => <span key={node.id} data-flow-node={node.id} />)}{children}</div>;
    },
  };
});

let built: string;
let W1: BuiltTemplate, M1: BuiltTemplate;
let f: ReturnType<typeof instanceSettingsFixture>;
let dir: string;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let thrown: unknown[];
let calls: string[];

beforeAll(async () => {
  built = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-page-canvas-"));
  M1 = await buildTemplate(path.join(built, "m1"), { id: "harbour-stations" });
  W1 = await buildTemplate(path.join(built, "w1"), { kind: "workflow", id: "busy-stations" });
});
afterAll(async () => { await rm(built, { recursive: true, force: true }); });

beforeEach(async () => {
  f = instanceSettingsFixture();
  who.db = f.db;
  resetCatalogueForTests();
  dir = await mkdtemp(path.join(process.cwd(), ".tmp-test-template-page-canvas-run-"));
  vi.spyOn(shippedIndex, "shippedTemplatesDir").mockReturnValue(await writeShippedFolder(path.join(dir, "shipped"), [M1]));
  await installFixture(W1, path.join(f.dir, "templates", "busy-stations", "1"), { kind: "catalogue", origin: "https://catalogue.example" });
  vi.stubEnv("DEZFIL_TEMPLATES_CATALOGUE", path.join(dir, "no-catalogue"));
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(call);
    if (call === "GET /api/operations") return Response.json({ operations: OPERATIONS });
    if (call === `GET /api/maps/${encodeURIComponent("template.busy-stations.1.map")}`) {
      return Response.json({ id: "template.busy-stations.1.map", name: "Busy stations", layers: [] });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  host = installDomHost();
  // The width queries the screens' bands read: one wide window.
  Object.assign(host.window, {
    innerWidth: 1440, innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  for (const id of ["header-actions-right", "header-actions-left", "header-crumb-slot"]) {
    const slot = host.document.createElement("div");
    slot.setAttribute("id", id);
    host.document.body.appendChild(slot);
  }
  thrown = [];
  root = createRoot(container as unknown as Element, { onUncaughtError: (error) => { thrown.push(error); } });
});
afterEach(async () => {
  act(() => root.unmount());
  host.uninstall();
  resetCatalogueForTests();
  f.close();
  await rm(dir, { recursive: true, force: true });
});

async function draw() {
  const page = (await TemplatePage({ params: Promise.resolve({ id: "busy-stations" }) })) as ReactElement;
  await act(async () => root.render(page));
  await settle();
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("a workflow example's address, drawn as the page serves it", () => {
  it("draws its canvas over the real furniture with no assistant pane, reading only the catalog and the map", async () => {
    await draw();
    expect(thrown.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
    expect(container.querySelector("[data-workflow-frame]")!.hasAttribute("data-view-only")).toBe(true);
    expect(container.querySelectorAll("[data-flow-node]").map((n) => n.getAttribute("data-flow-node")))
      .toEqual(expect.arrayContaining(["step-busy", "step-rings"]));
    expect(container.querySelector("[data-workflow-canvas]")).not.toBeNull();
    expect(host.document.querySelectorAll("[data-assistant-pane]")).toHaveLength(0);
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(calls.filter((c) => /^GET \/api\/(recipes|tables|workflows|runs|assistant)\b/.test(c))).toEqual([]);
  });

  it("opens the canvas as the instance's defaults say a canvas opens", async () => {
    await draw();
    expect(container.querySelector("[data-workflow-canvas]")!.getAttribute("data-view")).toBe("full");
    act(() => root.unmount());
    root = createRoot(container as unknown as Element, { onUncaughtError: (error) => { thrown.push(error); } });
    writeStoredSettings({ "canvas.opens": "framed" }, f.db);
    await draw();
    expect(thrown).toEqual([]);
    expect(container.querySelector("[data-workflow-canvas]")!.getAttribute("data-view")).toBe("framed");
  });
});

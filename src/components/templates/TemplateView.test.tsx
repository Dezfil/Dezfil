import { act, StrictMode, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATIONS } from "@/lib/operations/catalog";
import { defaultStyle } from "@/lib/style/defaults";
import type { TemplateDetail } from "@/lib/templates/card";
import type { OpenedTemplate } from "@/lib/templates/opened";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { WorkflowCanvas } from "../workflow-canvas/WorkflowCanvas";
import type { WorkflowStage } from "../workflow-canvas/WorkflowStage";
import { TemplateView } from "./TemplateView";

/**
 * A template opened read only, in the shell: How it's made where the
 * builder's inspector stands, Make a copy in the header as the one action.
 *
 * A map template is the reader's map on the template map's id, beside the
 * panel; the page only reads (the map, its layers' renders, the operation
 * catalog). A version not on this server yet is downloaded first, by the
 * version the page was served, then the page is served again; a refusal
 * says why with the way back. A workflow example is its canvas, view-only,
 * the panel in the pane's place, no results band, and nothing asked of
 * the recipe, run or dataset roads.
 *
 * The server is a fake answering through fetch; every request is kept.
 */

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
const probe = vi.hoisted(() => ({ stage: null as null | Record<string, unknown> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/templates/opened",
  useRouter: () => ({ refresh: nav.refresh, push: nav.push, replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: vi.fn() }) }));
// The panel measures itself for the header card: the host computes no layout.
vi.mock("../shell/use-header-reach", () => ({ useHeaderReach: () => {} }));
// The reader's stage draws with WebGL: here it is a probe of what it was handed.
vi.mock("../reader/MapReader", async (original) => ({
  ...(await original<typeof import("../reader/MapReader")>()),
  ReaderStage: (props: Record<string, unknown>) => {
    probe.stage = props;
    return <div data-reader-stage />;
  },
}));
// The canvas as the workflow page mounts it, without browser geometry.
vi.mock("next/dynamic", () => ({ default: () => function Canvas(props: ComponentProps<typeof WorkflowCanvas>) { return <WorkflowCanvas {...props} />; } }));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../workflow-canvas/WorkflowAssistantHost", () => ({ useWorkflowAssistant: () => ({ open: false, band: "two" }) }));
vi.mock("../workflow-canvas/CanvasFurniture", async (original) => ({
  ...(await original<typeof import("../workflow-canvas/CanvasFurniture")>()), CanvasFurniture: () => null,
}));
vi.mock("../workflow-canvas/CanvasStage", () => ({ CanvasStage: () => null }));
vi.mock("../workflow-canvas/CanvasGrid", () => ({ CanvasGrid: () => null }));
vi.mock("../workflow-canvas/CanvasMinimap", () => ({ CanvasMinimap: () => null }));
vi.mock("../workflow-canvas/ResultsBand", () => ({ ResultsBand: () => <div data-results-band /> }));
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

const SOURCES = [
  { name: "Transit office", licence: "CC-BY-4.0", credit: "Transit office, Example City" },
  { name: "Boundary office", licence: "ODbL-1.0", credit: "© Boundary office contributors" },
];
const HOW: TemplateDetail["howMade"] = {
  question: "Stations from the transit office, districts from the boundary office.",
  datasets: [
    { dataset: "stations", source: "Transit office", made: "Station points as published." },
    { dataset: "districts", source: "Boundary office", made: "District outlines, simplified." },
  ],
  styling: ["Stations as points in the first layer colour.", "Districts as translucent areas."],
};
const detail = (more: Partial<TemplateDetail>): TemplateDetail => ({
  id: "harbour-stations", kind: "map", version: 1, title: "Harbour stations", question: "Where are the stations?",
  place: "Example City", tags: ["First map"], dataDate: "2024-05", sources: SOURCES, steps: null,
  origin: "shipped", installed: 1, listed: null, present: true, size: 2_400_000, picture: "kept", howMade: HOW, ...more,
});
const dataset = (template: string, name: string, rowCount: number, geometryType: string) => ({
  id: `template.${template}.1.dataset.${name}`, name, rowCount, geometryColumn: "geom", geometryType,
});
const opened = (template: string, workflow: OpenedTemplate["workflow"] = null): OpenedTemplate => ({
  id: template, version: 1, revision: "c0ffee".padEnd(32, "0"), mapId: `template.${template}.1.map`,
  createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-05T10:00:00.000Z",
  datasets: [dataset(template, "stations", 6, "POINT"), dataset(template, "districts", 2, "POLYGON")], workflow,
});

const layer = (mapId: string, id: string, name: string, sql: string, geometry: string, ordinal: number) => ({
  id, mapId, name, sql, style: defaultStyle(geometry, ordinal), visible: true, tooltip: null, popup: null,
  publishedFields: null, inLegend: true, viz: null, filters: [], legendTitle: null, legendLabels: null, legendAttrs: null,
  ordinal, createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-05T10:00:00.000Z", editRevision: "r1",
  lastChangedAt: null, lastChangedBy: null,
});
const mapOf = (mapId: string, layers: ReturnType<typeof layer>[]) => ({
  id: mapId, name: "Harbour stations", viewport: { lng: -0.12, lat: 51.505, zoom: 12, pitch: 0, bearing: 0 },
  basemap: null, customBasemap: null, basemapLayers: null, note: null, legendCorner: null, legendOrder: [], timeline: null,
  widgets: [], widgetsPublished: true, createdAt: "2026-01-05T10:00:00.000Z", updatedAt: "2026-01-05T10:00:00.000Z",
  layers, owner: { name: "Template", sqlName: "template" }, editRevision: "c0ffee", lastChangedAt: null, lastChangedBy: null,
  projectId: null,
});
const HARBOUR_MAP = mapOf("template.harbour-stations.1.map", [
  layer("template.harbour-stations.1.map", "template.harbour-stations.1.layer.layer-stations", "Stations", "SELECT * FROM stations", "POINT", 0),
  layer("template.harbour-stations.1.map", "template.harbour-stations.1.layer.layer-districts", "Districts", "SELECT * FROM districts", "POLYGON", 1),
]);
const BUSY_MAP = mapOf("template.busy-stations.1.map", [
  layer("template.busy-stations.1.map", "template.busy-stations.1.layer.layer-rings", "Rings", "SELECT * FROM station_rings", "POLYGON", 0),
]);
const WORKFLOW: OpenedTemplate["workflow"] = {
  name: "Busy stations",
  steps: [
    { id: "step-busy", operation: "sql_step", parameters: { sql: "SELECT * FROM stations WHERE riders > 100", name: "busy_stations" },
      output: { id: "template.busy-stations.1.result.step-busy", name: "busy_stations", rowCount: 4, geometryColumn: "geom", geometryType: "POINT" },
      reads: ["stations"] },
    { id: "step-rings", operation: "buffer", parameters: { input: "busy_stations", distance: 250, name: "station_rings" },
      output: { id: "template.busy-stations.1.result.step-rings", name: "station_rings", rowCount: 4, geometryColumn: "geom", geometryType: "POLYGON" },
      reads: ["busy_stations"] },
  ],
  layout: {
    steps: { "step-busy": { x: 320, y: 40 }, "step-rings": { x: 620, y: 40 } }, sources: { stations: { x: 20, y: 40 } },
    notes: [], updatedAt: "2026-01-05T10:00:00.000Z",
  },
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let fetchAnswer: (call: Call) => Promise<Response> | Response;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let actions: HostElement;

const notFound = () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
function answer(call: Call): Response {
  if (call.method !== "GET") return notFound();
  if (call.path === "/api/operations") return Response.json({ operations: OPERATIONS });
  for (const map of [HARBOUR_MAP, BUSY_MAP]) {
    if (call.path === `/api/maps/${map.id}` || call.path === `/api/maps/${encodeURIComponent(map.id)}`) return Response.json(map);
    const layerRender = map.layers.find((l) => call.path === `/api/layers/${l.id}/render`);
    if (layerRender) {
      return Response.json({ layerId: layerRender.id, ok: true, mode: "inline", geojson: { type: "FeatureCollection", features: [] },
        featureCount: 6, geometryType: "POINT" });
    }
  }
  return notFound();
}

beforeEach(() => {
  nav.refresh.mockReset();
  nav.push.mockReset();
  probe.stage = null;
  calls = [];
  fetchAnswer = answer;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    return fetchAnswer(call);
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  actions = host.document.createElement("div");
  actions.setAttribute("id", "header-actions-right");
  host.document.body.appendChild(actions);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
/** Open the page; `strict` mounts it as development does, its effects run twice. */
async function open(template: TemplateDetail, read: OpenedTemplate | null, strict = false) {
  const view = (
    <TemplateView template={template} opened={read} basemapUrl="/basemap.json" basemapOverrideUrl={null}
      basemapOverrideAttribution={[]} basemaps={[]} />
  );
  await act(async () => root.render(strict ? <StrictMode>{view}</StrictMode> : view));
  await settle();
}
const panel = () => container.querySelector("[data-template-panel]");
const fold = (name: string) => panel()!.querySelector(`[data-fold="${name}"]`)!;
const text = (node: HostElement | null) => node?.textContent ?? null;
const writes = () => calls.filter((c) => c.method !== "GET");

describe("a map template opened", () => {
  it("draws the reader's map on the template map's id, beside the panel, and only reads", async () => {
    await open(detail({}), opened("harbour-stations"));
    expect(probe.stage).toMatchObject({ mapId: "template.harbour-stations.1.map", besidePanel: true, projectId: null });
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      "GET /api/layers/template.harbour-stations.1.layer.layer-districts/render",
      "GET /api/layers/template.harbour-stations.1.layer.layer-stations/render",
      "GET /api/maps/template.harbour-stations.1.map",
      "GET /api/operations",
    ]);
    expect(host.document.body.hasAttribute("data-template-view")).toBe(true);
  });

  it("keeps the version it opened: every read names it, and the template is never read again", async () => {
    await open(detail({}), opened("harbour-stations"));
    await act(async () => fold("layers").querySelector("button")!.click());
    await settle();
    expect(calls.filter((c) => c.path.startsWith("/api/templates"))).toEqual([]);
    expect(calls.filter((c) => c.path.includes("template.")).every((c) => c.path.includes("template.harbour-stations.1."))).toBe(true);
  });

  it("puts Make a copy in the header as the page's one action", async () => {
    await open(detail({}), opened("harbour-stations"));
    const buttons = actions.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("Make a copy of Harbour stations");
    expect(text(buttons[0])).toContain("Make a copy");
    for (const tag of ["input", "textarea", "select"]) expect(container.querySelectorAll(tag)).toHaveLength(0);
  });

  it("tells How it's made: the question and the data open, each dataset's source, licence, credit and date", async () => {
    await open(detail({}), opened("harbour-stations"));
    expect(panel()!.getAttribute("aria-label")).toBe("How it's made");
    expect(panel()!.getAttribute("data-beside")).toBe("map");
    expect(panel()!.querySelectorAll("[data-fold]").map((f) => f.getAttribute("data-fold"))).toEqual(["question", "data", "layers", "styling"]);
    expect(text(fold("question"))).toContain("Stations from the transit office, districts from the boundary office.");
    const rows = fold("data").querySelectorAll("[data-dataset]");
    expect(rows.map((r) => r.getAttribute("data-dataset"))).toEqual(["stations", "districts"]);
    const fact = (row: HostElement, name: string) => text(row.querySelector(`[data-fact="${name}"]`));
    expect([fact(rows[0], "source"), fact(rows[0], "licence"), fact(rows[0], "credit"), fact(rows[0], "date")])
      .toEqual(["Transit office", "CC-BY-4.0", "Transit office, Example City", "May 2024"]);
    expect([fact(rows[1], "source"), fact(rows[1], "licence"), fact(rows[1], "credit")])
      .toEqual(["Boundary office", "ODbL-1.0", "© Boundary office contributors"]);
    expect(text(rows[0])).toContain("Station points as published. · 6 rows");
  });

  it("folds each section open and shut, the layers' SQL and style inside", async () => {
    await open(detail({}), opened("harbour-stations"));
    const head = (name: string) => fold(name).querySelector("button")!;
    expect(head("question").getAttribute("aria-expanded")).toBe("true");
    expect(head("layers").getAttribute("aria-expanded")).toBe("false");
    expect(fold("layers").querySelectorAll("[data-layer-sql]")).toHaveLength(0);
    await act(async () => head("layers").click());
    expect(fold("layers").querySelectorAll("[data-layer-sql]").map((s) => text(s)))
      .toEqual(["SELECT * FROM stations", "SELECT * FROM districts"]);
    expect(fold("layers").querySelectorAll("[data-layer-style]").every((s) => (text(s) ?? "").startsWith("One colour"))).toBe(true);
    await act(async () => head("styling").click());
    expect(fold("styling").querySelectorAll("li").map((li) => text(li))).toEqual(HOW.styling);
    await act(async () => head("question").click());
    expect(head("question").getAttribute("aria-expanded")).toBe("false");
    expect(text(fold("question"))).not.toContain("transit office, districts");
  });
});

describe("a version not on this server yet", () => {
  it("downloads the version the page was served, once, says so meanwhile, then has the page served again", async () => {
    let release!: (response: Response) => void;
    fetchAnswer = (call) => (call.method === "POST" ? new Promise<Response>((resolve) => { release = resolve; }) : answer(call));
    await open(detail({ id: "quiet-park", version: 2, present: false, installed: 1, listed: 2, origin: "catalogue", size: 3 * 1024 * 1024 }), null, true);
    expect(writes()).toEqual([{ method: "POST", path: "/api/templates/quiet-park/fetch", body: { version: 2 } }]);
    expect(text(container.querySelector("[data-template-downloading]"))).toBe("Downloading the template, 3.0 MB…");
    expect(nav.refresh).not.toHaveBeenCalled();
    await act(async () => release(Response.json({ id: "quiet-park", version: 2 })));
    await settle();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(1);
  });

  it("says why a download was refused, with the way back and a retry of the same version", async () => {
    fetchAnswer = (call) => call.method === "POST"
      ? Response.json({ error: { code: "egress_blocked", message: "This server may not reach the catalogue." } }, { status: 403 })
      : answer(call);
    await open(detail({ id: "quiet-park", version: 2, present: false, installed: null, listed: 2, origin: "catalogue" }), null);
    const fallback = container.querySelector("[data-template-fallback]")!;
    expect(text(fallback)).toContain("This server may not reach the catalogue.");
    expect(fallback.querySelector("a")!.getAttribute("href")).toBe("/templates");
    expect(nav.refresh).not.toHaveBeenCalled();
    await act(async () => fallback.querySelector("button")!.click());
    await settle();
    expect(writes().map((c) => c.body)).toEqual([{ version: 2 }, { version: 2 }]);
  });

  it("says so when an installed version's files cannot be read, and asks nothing", async () => {
    await open(detail({}), null);
    expect(text(container.querySelector("[data-template-fallback]"))).toContain("This template's files could not be read on this server.");
    expect(writes()).toEqual([]);
  });
});

describe("a workflow example opened", () => {
  const busy = () => detail({
    id: "busy-stations", kind: "workflow", title: "Busy stations", origin: "catalogue",
    steps: [
      { id: "step-busy", operation: "sql_step", output: "busy_stations", reads: ["stations"] },
      { id: "step-rings", operation: "buffer", output: "station_rings", reads: ["busy_stations"] },
    ],
  });

  it("draws its canvas view-only from the page's documents, the panel in the pane's place, no band", async () => {
    await open(busy(), opened("busy-stations", WORKFLOW));
    expect(container.querySelector("[data-workflow-frame]")!.hasAttribute("data-view-only")).toBe(true);
    expect(container.querySelectorAll("[data-flow-node]").map((n) => n.getAttribute("data-flow-node")).sort())
      .toEqual(expect.arrayContaining(["step-busy", "step-rings"]));
    expect(panel()!.getAttribute("data-beside")).toBe("canvas");
    expect(panel()!.hasAttribute("data-canvas-pane")).toBe(true);
    expect(fold("workflow")).toBeTruthy();
    expect(container.querySelectorAll("[data-results-band]")).toHaveLength(0);
  });

  it("asks nothing of the recipe, run or dataset roads, and only reads", async () => {
    await open(busy(), opened("busy-stations", WORKFLOW));
    expect(writes()).toEqual([]);
    expect(calls.filter((c) => /^\/api\/(recipes|tables|workflows|runs)\b/.test(c.path))).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(["/api/operations", "/api/maps/template.busy-stations.1.map"]));
  });

  it("keeps Make a copy as the only action in the header", async () => {
    await open(busy(), opened("busy-stations", WORKFLOW));
    expect(actions.querySelectorAll("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Make a copy of Busy stations"]);
  });
});

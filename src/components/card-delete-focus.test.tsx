import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "./api";
import type { ProjectOverview } from "./projects/model";
import type { WorkflowListing } from "./workflow-model";
import { SignedIn } from "./sharing/signed-in";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { MapsScreen } from "./MapsScreen";
import { ProjectsScreen } from "./ProjectsScreen";
import { TablesScreen } from "./TablesScreen";
import { WorkflowsScreen } from "./WorkflowsScreen";

/**
 * A card's in-place Delete on the four list pages, pressed twice from the
 * keyboard: the deleted card takes its focused button with it, and focus
 * lands on the next card's Delete rather than on the document. Each page's
 * list is a stand-in that holds its state, so the page's own deletion
 * removes the card; the server answers every deletion.
 */

const server = vi.hoisted(() => ({ world: null as unknown, deleted: [] as string[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "name", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/ScopeFilter", () => ({ ScopeFilter: () => null }));
// The lists' reads as state: a mutation changes what is drawn, and a
// re-read takes the server's list as it now stands.
vi.mock("./scope/use-scope-world", async () => {
  const { useState } = await import("react");
  return {
    useScopeWorld: () => {
      const [world, setWorld] = useState(server.world);
      return {
        state: { status: "ready", value: world },
        retry: () => {},
        mutate: (change: (w: unknown) => unknown) => setWorld(change),
        refresh: async () => setWorld(server.world),
      };
    },
  };
});
vi.mock("./projects/read", async () => {
  const { useState } = await import("react");
  return {
    useProjectsWorld: () => {
      const [world, setWorld] = useState(server.world);
      return {
        state: { status: "ready", value: world },
        retry: () => {},
        mutate: (change: (w: unknown) => unknown) => setWorld(change),
        refresh: async () => setWorld(server.world),
      };
    },
  };
});
vi.mock("./shell/use-project-name", () => ({ invalidateProjects: () => {} }));
vi.mock("./sharing/use-project-people", async (original) => ({
  ...(await original<typeof import("./sharing/use-project-people")>()),
  useProjectPeople: () => new Map(),
}));
vi.mock("./use-async-collection", () => ({
  useAsyncCollection: () => ({ state: { status: "ready", value: [] }, retry: vi.fn(), mutate: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-grid-columns", () => ({ useGridColumns: () => null }));
vi.mock("./use-upload-queue", () => ({
  useUploadQueue: () => ({ entries: [], add: vi.fn(), dismiss: () => 0, current: () => ({ settled: true }), reset: vi.fn() }),
}));
vi.mock("./AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./projects/AddToProjectDialog", () => ({ AddToProjectDialog: () => null }));
vi.mock("./AddToMapDialog", async (original) => ({ ...(await original<typeof import("./AddToMapDialog")>()), AddToMapDialog: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const stamp = { createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", editRevision: "r1" };

const map = (id: string, name: string): MapOverview =>
  ({
    id, name, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap: null, customBasemap: null, basemapLayers: null,
    note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: false,
    publishToken: null, publishedAt: null, published: false, ...stamp,
    projectId: null, owner: ada, home: ada.sqlName, layerCount: 1, layerColors: [],
  }) as unknown as MapOverview;
const workflow = (id: string, name: string): WorkflowListing =>
  ({
    id, name, origin: "workflow", projectId: null, ...stamp,
    summary: { status: "never_run", count: 0, nodes: 1, sources: 0, liveOutputs: 0 }, steps: [], owner: ada, home: ada.sqlName,
  }) as unknown as WorkflowListing;
const project = (id: string, name: string): ProjectOverview => ({
  id, name, note: null, ...stamp, mapCount: 0, publishedMapCount: 0, recipeCount: 0, tableCount: 0,
  sizeBytes: 0, sizeComplete: true, role: "owner", owner: ada,
});
const table = (name: string): TableListing =>
  ({
    id: `t-${name}`, name, qualifiedName: name, owner: ada, geometryColumn: "geom", geometryType: "POINT",
    rowCount: 10, sizeBytes: 100, projectIds: [], source: "upload", ...stamp, importedAt: null,
  }) as unknown as TableListing;

/** What each page lists, and the key the server deletes it by. */
const pages = {
  Maps: {
    screen: () => <MapsScreen />,
    world: () => ({ projects: [], all: [], scoped: [map("m1", "Berth occupancy"), map("m2", "Station catchments")] }),
    path: /^\/api\/maps\/(\w+)$/,
    drop: (w: { all: { id: string }[]; scoped: { id: string }[] }, key: string) => ({ ...w, all: w.all.filter((x) => x.id !== key), scoped: w.scoped.filter((x) => x.id !== key) }),
  },
  Workflows: {
    screen: () => <WorkflowsScreen />,
    world: () => ({ projects: [], all: [], scoped: [workflow("w1", "Permit geocoding"), workflow("w2", "Vessel density")] }),
    path: /^\/api\/recipes\/(\w+)$/,
    drop: (w: { all: { id: string }[]; scoped: { id: string }[] }, key: string) => ({ ...w, all: w.all.filter((x) => x.id !== key), scoped: w.scoped.filter((x) => x.id !== key) }),
  },
  Projects: {
    screen: () => <ProjectsScreen />,
    world: () => ({ projects: [project("p1", "Port traffic"), project("p2", "Quay survey")], maps: [], workflows: [], tables: [] }),
    path: /^\/api\/projects\/(\w+)$/,
    drop: (w: { projects: { id: string }[] }, key: string) => ({ ...w, projects: w.projects.filter((x) => x.id !== key) }),
  },
  Data: {
    screen: () => <TablesScreen />,
    world: () => ({ projects: [], all: [], scoped: [table("quays"), table("roads")] }),
    path: /^\/api\/tables\/(\w+)$/,
    drop: (w: { all: { name: string }[]; scoped: { name: string }[] }, key: string) => ({ ...w, all: w.all.filter((x) => x.name !== key), scoped: w.scoped.filter((x) => x.name !== key) }),
  },
} as const;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
let page: (typeof pages)[keyof typeof pages];

beforeEach(() => {
  server.deleted = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const key = page.path.exec(url)?.[1];
    if (init?.method === "DELETE" && key) {
      server.deleted.push(key);
      server.world = (page.drop as (w: unknown, key: string) => unknown)(server.world, key);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const deletes = () => container.querySelectorAll("button").filter((b) => /^Delete /.test(b.getAttribute("aria-label") ?? ""));

describe.each(Object.keys(pages) as (keyof typeof pages)[])("the %s page's in-place Delete", (name) => {
  it("leaves focus on the next card's Delete once the focused card is gone", async () => {
    page = pages[name];
    server.world = page.world();
    await act(async () => root.render(<SignedIn account={ada}>{page.screen()}</SignedIn>));
    await settle();
    const [first, next] = deletes();
    expect(next, "two cards to delete from").toBeDefined();
    const gone = first.getAttribute("aria-label");
    first.focus();
    await act(async () => first.click());
    expect(first.textContent, "the first press arms").toMatch(/^Delete\?/);
    await act(async () => first.click());
    await settle();
    expect(server.deleted, "the second press deletes").toHaveLength(1);
    expect(deletes().map((b) => b.getAttribute("aria-label"))).not.toContain(gone);
    const active = host.document.activeElement;
    expect(active).not.toBe(host.document.body);
    expect(active?.isConnected, "focus is on something still on the page").toBe(true);
    expect(active).toBe(next);
  });
});

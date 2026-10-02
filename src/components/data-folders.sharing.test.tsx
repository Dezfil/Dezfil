import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableListing } from "./api";
import type { WorkflowListing } from "./workflow-model";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { SignedIn } from "./sharing/signed-in";
import { TablesScreen } from "./TablesScreen";

/**
 * On the Data page, a workflow folder stands among the dataset cards; when
 * the workflow is someone else's, its card carries the same owner pill as
 * the dataset cards beside it (the owner's initials in the corner, the name
 * on hover), and its list row carries it after the name. One's own folder
 * carries nothing.
 */

const doors = vi.hoisted(() => ({
  push: vi.fn(),
  view: "grid" as "grid" | "list",
  world: null as unknown,
  workflows: [] as unknown[],
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: doors.push, replace: vi.fn() }),
  usePathname: () => "/data",
}));
vi.mock("./use-view-prefs", () => ({
  useViewPrefs: () => ({ view: doors.view, sort: "updated", setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: doors.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./scope/ScopeFilter", () => ({ ScopeFilter: () => null }));
vi.mock("./use-async-collection", () => ({
  useAsyncCollection: () => ({ state: { status: "ready", value: doors.workflows }, retry: vi.fn(), mutate: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-grid-columns", () => ({ useGridColumns: () => null }));
vi.mock("./use-upload-queue", () => ({ useUploadQueue: () => ({ add: vi.fn(), dismiss: () => 0, current: () => ({ settled: true }), reset: vi.fn() }) }));
vi.mock("./AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./projects/AddToProjectDialog", () => ({ AddToProjectDialog: () => null }));
vi.mock("./AddToMapDialog", async (original) => ({
  ...(await original<typeof import("./AddToMapDialog")>()),
  AddToMapDialog: ({ subject }: { subject: { sql: string } | null }) =>
    subject ? <div data-add-to-map={subject.sql} /> : null,
}));
const catalogue = vi.hoisted(() => ({ listing: null as unknown }));
vi.mock("./builder/add-layer/use-catalog-tables", () => ({
  useCatalogTables: () => ({ listing: catalogue.listing, retry: vi.fn() }),
}));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./ui/Dialog", () => ({ Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: ({ name }: { name: string }) => <div data-page-map={name} /> }));
vi.mock("./set-geometry/ChoicePreviewMap", () => ({ ChoicePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
// The menu's items as plain links, so the export addresses can be read.
vi.mock("./ui/Menu", () => ({
  Menu: ({ children, label }: { children: React.ReactNode; label: string }) => <div data-menu={label}>{children}</div>,
  MenuItem: ({ href, children }: { href?: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const table = (id: string, name: string, owner: typeof ada): TableListing =>
  ({
    id, name, qualifiedName: owner === bo ? name : `${owner.sqlName}.${name}`, owner,
    geometryColumn: "geom", geometryType: "POLYGON", rowCount: 10, sizeBytes: 100, projectIds: ["berlin"],
    source: "operation", sourceParams: null, createdAt: "2026-09-01T00:00:00Z", importedAt: "2026-09-01T00:00:00Z",
    crsAssumed: false, headerSuspect: false,
  }) as unknown as TableListing;
const workflow = (id: string, name: string, owner: typeof ada, output: string): WorkflowListing =>
  ({
    id, name, origin: "workflow", projectId: "berlin", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    summary: { status: "never_run", count: 0, nodes: 2, sources: 1, liveOutputs: 1 }, owner, home: owner.sqlName,
    steps: [{ id: `s-${id}`, output: { id: output } }],
  }) as unknown as WorkflowListing;

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  doors.world = {
    projects: [{ id: "berlin", name: "Berlin housing study" }],
    all: [], scoped: [table("t-buffered", "buffered", ada), table("t-zones", "zones", bo), table("t-loose", "blocks", ada)],
  };
  doors.workflows = [workflow("w-ada", "Buffer roads", ada, "t-buffered"), workflow("w-bo", "Zone stations", bo, "t-zones")];
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const mount = (view: "grid" | "list") => act(async () => {
  doors.view = view;
  root.render(<SignedIn account={bo}><TablesScreen /></SignedIn>);
  await new Promise((r) => setTimeout(r, 0));
});
const pill = (item: HostElement | null) => item?.querySelector("[data-owner-pill]")?.getAttribute("data-owner-pill") ?? null;

describe("a workflow folder on the Data page", () => {
  it("carries Ada's pill on her workflow's card, as her dataset's card beside it does", async () => {
    await mount("grid");
    expect(pill(container.querySelector('[data-folder-card="w-ada"]'))).toBe("ada");
    expect(container.querySelector('[data-folder-card="w-ada"]')?.querySelector("[data-owner-pill]")?.getAttribute("data-placement")).toBe("corner");
    expect(container.querySelectorAll("article").map(pill).filter(Boolean)).toEqual(["ada", "ada"]);
  });

  it("carries it after the name in the list row", async () => {
    await mount("list");
    const row = container.querySelector('[data-folder-row="w-ada"]');
    expect(pill(row)).toBe("ada");
    expect(row?.querySelector("[data-owner-pill]")?.getAttribute("data-placement")).toBe("inline");
  });

  it("leaves Bo's own folder unmarked", async () => {
    await mount("grid");
    expect(container.querySelector('[data-folder-card="w-bo"]')).not.toBeNull();
    expect(pill(container.querySelector('[data-folder-card="w-bo"]'))).toBeNull();
    await mount("list");
    expect(pill(container.querySelector('[data-folder-row="w-bo"]'))).toBeNull();
  });
});

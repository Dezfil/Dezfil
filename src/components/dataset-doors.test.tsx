import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableListing } from "./api";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { SignedIn } from "./sharing/signed-in";
import { doorTable } from "./dataset-doors";
import { tableReference, starterSql } from "./sql/sql-draft";

/**
 * Every door to a dataset addresses it by the name its reader types: one's
 * own by its plain name, someone else's by `<sql name>.<name>`. Bo owns a
 * `roads` and reaches Ada's `roads` through a project they share; each door
 * on Ada's must open Ada's, never Bo's own.
 */

const doors = vi.hoisted(() => ({
  push: vi.fn(),
  view: "grid" as "grid" | "list",
  world: null as unknown,
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
  useAsyncCollection: () => ({ state: { status: "ready", value: [] }, retry: vi.fn(), mutate: vi.fn(), replace: vi.fn() }),
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
const roads = (owner: typeof ada): TableListing =>
  ({
    id: `t-${owner.sqlName}`, name: "roads", qualifiedName: owner === bo ? "roads" : `${owner.sqlName}.roads`, owner,
    geometryColumn: "geom", geometryType: "LINESTRING", rowCount: 10, sizeBytes: 100, projectIds: ["berlin"],
    source: "upload", sourceParams: null, createdAt: "2026-09-01T00:00:00Z", importedAt: "2026-09-01T00:00:00Z",
    crsAssumed: false, headerSuspect: false,
  }) as unknown as TableListing;
const BOTH = [roads(bo), roads(ada)];

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  doors.push.mockReset();
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const mount = (node: React.ReactNode) => act(async () => {
  root.render(<SignedIn account={bo}>{node}</SignedIn>);
  await new Promise((r) => setTimeout(r, 0));
});
/** Ada's copy of a control: the one inside the item her pill marks. */
function adas(selector: string): HostElement {
  const item = container.querySelectorAll("[data-owner-pill]").map((pill) => {
    let n: HostElement | null = pill;
    while (n && !n.matches("article") && !n.matches("tr") && !n.matches("button")) n = n.parentElement;
    return n!;
  })[0];
  expect(item, "Ada's item is listed").toBeTruthy();
  const control = item.matches(selector) ? item : item.querySelector(selector);
  expect(control, selector).toBeTruthy();
  return control!;
}

describe("the console's door and the SQL it seeds", () => {
  it("finds the dataset whose typed name the door carries", () => {
    expect(doorTable(BOTH, "ada.roads")?.id).toBe("t-ada");
    expect(doorTable(BOTH, "roads")?.id).toBe("t-bo");
    expect(doorTable([roads(ada)], "roads")).toBeNull();
  });

  it("writes someone else's dataset as it is typed, each part bare when it can be", () => {
    expect(tableReference("ada.roads")).toBe("ada.roads");
    expect(tableReference("roads")).toBe("roads");
    expect(tableReference("ada.select")).toBe('ada."select"');
    expect(starterSql("ada.roads")).toBe("SELECT *\nFROM ada.roads\nLIMIT 100;");
  });
});

describe.each(["grid", "list"] as const)("the Data list's doors on Ada's roads (%s)", (layout) => {
  beforeEach(async () => {
    doors.view = layout;
    doors.world = { projects: [{ id: "berlin", name: "Berlin housing study" }], all: BOTH, scoped: BOTH };
    const { TablesScreen } = await import("./TablesScreen");
    await mount(<TablesScreen />);
  });

  it("opens Ada's page", async () => {
    await act(async () => adas(layout === "grid" ? '[role="link"]' : "tr").click());
    expect(doors.push).toHaveBeenCalledWith("/tables/ada.roads");
  });

  it("queries Ada's roads in SQL", async () => {
    await act(async () => adas('[aria-label="Query roads in SQL"]').click());
    expect(doors.push).toHaveBeenCalledWith("/sql?table=ada.roads");
  });

  it("adds Ada's roads to a map", async () => {
    await act(async () => adas('[aria-label="Add roads to a map"]').click());
    expect(container.querySelector("[data-add-to-map]")?.getAttribute("data-add-to-map")).toBe("SELECT * FROM ada.roads");
  });

  it("exports Ada's roads", () => {
    const links = adas('[data-menu="Export roads"]').querySelectorAll("a").map((a) => a.getAttribute("href"));
    expect(links).toContain("/api/tables/ada.roads/export?format=geoparquet");
    expect(links.every((href) => href!.startsWith("/api/tables/ada.roads/"))).toBe(true);
  });
});

describe.each(["cards", "list"] as const)("the project home's door on Ada's roads (%s)", (view) => {
  it("opens Ada's page", async () => {
    const { HomeSections } = await import("./projects/HomeSections");
    await mount(
      <HomeSections projectId="berlin" maps={[]} workflows={[]} tables={BOTH} names={new Map()}
        lastRuns={new Map()} view={view} groupOf={() => null} />,
    );
    await act(async () => adas(view === "cards" ? '[role="link"]' : "button").click());
    expect(doors.push).toHaveBeenCalledWith("/tables/ada.roads");
  });
});

describe("the dataset page's doors on Ada's roads", () => {
  beforeEach(async () => {
    const inspection = { ...roads(ada), columns: [{ name: "geom", type: "GEOMETRY" }], preview: [], inputs: null };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== "/api/tables/ada.roads") throw new Error(`unexpected fetch ${String(input)}`);
      return { ok: true, json: async () => inspection };
    }));
    const { TableDetailScreen } = await import("./TableDetailScreen");
    await mount(<TableDetailScreen name="ada.roads" />);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("previews Ada's features on the map", () => {
    expect(container.querySelector("[data-page-map]")?.getAttribute("data-page-map")).toBe("ada.roads");
  });

  it("queries Ada's roads in SQL", async () => {
    await act(async () => container.querySelector('[aria-label="Query roads in SQL"]')!.click());
    expect(doors.push).toHaveBeenCalledWith("/sql?table=ada.roads");
  });

  it("exports Ada's roads", () => {
    const links = container.querySelector('[data-menu="Export roads"]')!.querySelectorAll("a").map((a) => a.getAttribute("href"));
    expect(links).toContain("/api/tables/ada.roads/export?format=csv");
    expect(links.every((href) => href!.startsWith("/api/tables/ada.roads/"))).toBe(true);
  });
});

describe("the catalogue's set-geometry door", () => {
  it("opens the page of the dataset picked, Ada's, with the panel", async () => {
    const flat = BOTH.map((t) => ({ ...t, geometryColumn: null, geometryType: null }));
    catalogue.listing = {
      world: { projects: [], all: flat }, worldError: null, offered: flat, offeredError: null, onRetry: vi.fn(),
    };
    const { AddLayerCatalog } = await import("./builder/add-layer/AddLayerCatalog");
    await mount(
      <AddLayerCatalog request={{ kind: "add" }} onClose={vi.fn()} createLayer={vi.fn()}
        onPostgisTableImported={vi.fn()} uploadQueue={{ entries: [], active: null, position: 0, skips: [], softNotes: null, add: vi.fn() } as never} />,
    );
    const tablesSource = container.querySelectorAll("button").find((b) => b.textContent.startsWith("Tables"))!;
    await act(async () => tablesSource.click());
    expect(container.querySelectorAll('button[aria-label="roads"]')).toHaveLength(1);
    await act(async () => container.querySelector('button[aria-label="ada.roads"]')!.click());
    await act(async () => container.querySelector('[data-set-geometry-door="catalog"]')!.click());
    expect(doors.push).toHaveBeenCalledWith("/tables/ada.roads?geometry=set");
  });
});

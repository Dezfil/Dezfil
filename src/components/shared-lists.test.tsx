import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "./api";
import type { WorkflowListing } from "./workflow-model";
import { MapsScreen } from "./MapsScreen";
import { WorkflowsScreen } from "./WorkflowsScreen";
import { TableCard, TableRow, type TableActionsProps } from "./data-cards";
import { SignedIn } from "./sharing/signed-in";

/**
 * Someone else's map, workflow or dataset in the lists: a small pill with
 * the owner's initials in the picture's corner (the owner's name on hover),
 * in the name cell of a list row; nothing on one's own. Its quick actions
 * keep what reads it and drop what stays its owner's: filing, publishing,
 * deleting.
 */

const lists = vi.hoisted(() => ({ view: "grid" as "grid" | "list", world: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: lists.view, sort: "edited", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: lists.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const projects = [{ id: "berlin", name: "Berlin housing study" }];

const map = (id: string, name: string, owner: typeof ada, published = false): MapOverview =>
  ({
    id, name, viewport: { lng: 0, lat: 0, zoom: 2 }, basemap: null, customBasemap: null, basemapLayers: null,
    note: null, legendCorner: null, legendOrder: null, timeline: null, widgets: [], widgetsPublished: false,
    // The token is the owner's alone: Bo reads Ada's published map as published, with no token.
    publishToken: published && owner === bo ? `token-${id}` : null, publishedAt: published ? "2026-09-01T00:00:00Z" : null, published,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    projectId: "berlin", owner, home: owner.sqlName, layerCount: 1, layerColors: [],
  }) as unknown as MapOverview;

const workflow = (id: string, name: string, owner: typeof ada): WorkflowListing =>
  ({
    id, name, origin: "workflow", projectId: "berlin", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    summary: { status: "never_run", count: 0, nodes: 1, sources: 0, liveOutputs: 0 }, steps: [], owner, home: owner.sqlName,
  }) as unknown as WorkflowListing;

function asBo(node: React.ReactNode) {
  return renderToStaticMarkup(<SignedIn account={bo}>{node}</SignedIn>);
}

describe.each(["grid", "list"] as const)("the Maps list (%s)", (layout) => {
  const render = () => {
    lists.view = layout;
    lists.world = { projects, all: [], scoped: [map("m-ada", "Station catchments", ada, true), map("m-bo", "Berth occupancy", bo)] };
    return asBo(<MapsScreen />);
  };

  it("marks Ada's map with her initials and her name on hover, and Bo's own with nothing", () => {
    const html = render();
    expect(html.match(/data-owner-pill=/g)).toHaveLength(1);
    expect(html).toContain('data-owner-pill="ada"');
    expect(html).toContain('data-hint="Shared by Ada Okafor"');
    expect(html).toContain(`data-placement="${layout === "grid" ? "corner" : "inline"}"`);
  });

  it("keeps only what reads Ada's map among its quick actions", () => {
    const html = render();
    expect(html).toContain('aria-label="Duplicate Station catchments"');
    // Her link is hers to hand out: Bo reads that it is published, not the link.
    expect(html).not.toContain('aria-label="Copy share link for Station catchments"');
    expect(html).not.toContain('aria-label="Delete Station catchments"');
    expect(html).not.toMatch(/aria-label="[^"]*project[^"]*: Station catchments"/i);
    expect(html).toContain('aria-label="Delete Berth occupancy"');
    expect(html).toContain('aria-label="Publish Berth occupancy"');
  });

  it("marks nothing while the signed-in person is unknown", () => {
    lists.view = layout;
    expect(renderToStaticMarkup(<MapsScreen />)).not.toContain("data-owner-pill");
  });
});

describe.each(["grid", "list"] as const)("the Maps list's open door (%s)", (layout) => {
  const render = (role: "viewer" | "editor") => {
    lists.view = layout;
    lists.world = {
      projects: [{ id: "berlin", name: "Berlin housing study", role, owner: ada }],
      all: [], scoped: [map("m-ada", "Station catchments", ada), map("m-bo", "Berth occupancy", bo)],
    };
    return asBo(<MapsScreen />);
  };

  it("says Open, not Open in builder, on a map Bo may only view", () => {
    const html = render("viewer");
    expect(html).toContain('aria-label="Open Station catchments"');
    expect(html).not.toContain('aria-label="Open Station catchments in the builder"');
    expect(html).toContain('aria-label="Open Berth occupancy in the builder"');
  });

  it("keeps Open in builder on a map Bo edits", () => {
    expect(render("editor")).toContain('aria-label="Open Station catchments in the builder"');
  });
});

describe.each(["grid", "list"] as const)("the Workflows list (%s)", (layout) => {
  const render = () => {
    lists.view = layout;
    lists.world = { projects, all: [], scoped: [workflow("w-ada", "Permit geocoding", ada), workflow("w-bo", "Vessel density", bo)] };
    return asBo(<WorkflowsScreen />);
  };

  it("marks Ada's workflow with her initials and leaves Bo's unmarked", () => {
    const html = render();
    expect(html.match(/data-owner-pill=/g)).toHaveLength(1);
    expect(html).toContain('data-hint="Shared by Ada Okafor"');
  });

  it("drops filing and deleting from Ada's workflow", () => {
    const html = render();
    expect(html).toContain('aria-label="Duplicate Permit geocoding"');
    expect(html).not.toContain('aria-label="Delete Permit geocoding"');
    expect(html).not.toMatch(/aria-label="[^"]*project[^"]*: Permit geocoding"/i);
    expect(html).toContain('aria-label="Delete Vessel density"');
  });
});

describe("the Data list's card and row", () => {
  const table = (name: string, owner: typeof ada) =>
    ({
      id: `t-${name}`, name, qualifiedName: owner === bo ? name : `${owner.sqlName}.${name}`, owner,
      geometryColumn: "geom", geometryType: "POINT", rowCount: 10, sizeBytes: 100, projectIds: ["berlin"],
      source: "upload", createdAt: "2026-09-01T00:00:00Z", importedAt: null,
    }) as unknown as TableListing;
  const actions = (t: TableListing): TableActionsProps => ({
    table: t, confirming: false, deleting: false, onOpen: vi.fn(), onQuery: vi.fn(), onAddToMap: vi.fn(),
    onFile: vi.fn(), onDeletePress: vi.fn(), onDeleteBlur: vi.fn(),
  });

  it("marks Ada's dataset in the card's corner and drops filing and deleting", () => {
    const t = table("roads", ada);
    const html = renderToStaticMarkup(<TableCard table={t} index={0} actions={actions(t)} owner={ada} />);
    expect(html).toContain('data-placement="corner"');
    expect(html).toContain('data-hint="Shared by Ada Okafor"');
    expect(html).not.toContain('aria-label="Delete roads"');
    expect(html).not.toContain('aria-label="Add to a project: roads"');
    expect(html).toContain('aria-label="Query roads in SQL"');
  });

  it("marks Ada's dataset in the row's name cell", () => {
    const t = table("roads", ada);
    const html = renderToStaticMarkup(<table><tbody><TableRow table={t} actions={actions(t)} owner={ada} /></tbody></table>);
    expect(html).toContain('data-placement="inline"');
    expect(html).not.toContain('aria-label="Delete roads"');
  });

  it("leaves Bo's own dataset as it was", () => {
    const t = table("roads", bo);
    const html = renderToStaticMarkup(<TableCard table={t} index={0} actions={actions(t)} owner={null} />);
    expect(html).not.toContain("data-owner-pill");
    expect(html).toContain('aria-label="Delete roads"');
    expect(html).toContain('aria-label="Add to a project: roads"');
  });
});

describe("one's own work still filed in a project one no longer reaches", () => {
  it("says so on the map and workflow cards, never that it is in no project, and keeps its filing door", () => {
    lists.view = "grid";
    lists.world = { projects, all: [], scoped: [{ ...map("m-bo", "Berth occupancy", bo), projectId: "gone" }] };
    const maps = asBo(<MapsScreen />);
    lists.world = { projects, all: [], scoped: [{ ...workflow("w-bo", "Vessel density", bo), projectId: "gone" }] };
    const workflows = asBo(<WorkflowsScreen />);
    for (const [html, name] of [[maps, "Berth occupancy"], [workflows, "Vessel density"]]) {
      expect(html, name).toContain("a project you no longer reach");
      expect(html, name).not.toContain("not in a project");
      expect(html, name).toMatch(new RegExp(`aria-label="[^"]*project[^"]*: ${name}"`, "i"));
    }
  });
});

describe("a published map someone else owns", () => {
  it("reads as published on its card and in the Published count without its token, and its link stays with the owner's own", () => {
    lists.view = "grid";
    lists.world = { projects, all: [], scoped: [map("m-ada", "Station catchments", ada, true), map("m-bo", "Berth occupancy", bo, true)] };
    const html = asBo(<MapsScreen />);
    expect(html.match(/data-live="true"/g)).toHaveLength(2);
    expect(html).not.toContain(">Draft<");
    expect(html).toContain('aria-label="Copy share link for Berth occupancy"');
    expect(html).not.toContain('aria-label="Copy share link for Station catchments"');
    expect(html).not.toContain("token-m-ada");
  });
});

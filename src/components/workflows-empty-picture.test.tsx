import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowListing } from "./workflow-model";
import { WorkflowsScreen } from "./WorkflowsScreen";
import { SignedIn } from "./sharing/signed-in";

/**
 * The Workflows page's card and compact row draw a workflow's graph in
 * their picture; a workflow with no nodes has no graph to draw, so it shows
 * the chart-paper placeholder an empty map's card shows, not a blank
 * picture.
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
vi.mock("./WorkflowThumb", () => ({ WorkflowThumb: () => <i data-graph="" /> }));
vi.mock("./gallery-icons", async (original) => ({ ...await original<object>(), MapPlaceholder: () => <i data-placeholder="" /> }));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };

const workflow = (id: string, name: string, nodes: number): WorkflowListing =>
  ({
    id, name, origin: "workflow", projectId: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    summary: { status: "never_run", count: 0, nodes, sources: 0, liveOutputs: 0 },
    steps: Array.from({ length: nodes }, (_, i) => ({ id: `s${i}` })), owner: bo, home: bo.sqlName,
  }) as unknown as WorkflowListing;

/** The picture drawn first after an item's own Open label: its own. */
function pictureOf(html: string, name: string): string | null {
  const at = html.indexOf(`aria-label="Open ${name}"`);
  expect(at, `${name} is drawn`).toBeGreaterThanOrEqual(0);
  return /data-(graph|placeholder)=/.exec(html.slice(at))?.[1] ?? null;
}

describe.each(["grid", "list"] as const)("the Workflows page's %s", (layout) => {
  it("draws the placeholder for a workflow with no nodes and the graph for one with nodes", () => {
    lists.view = layout;
    lists.world = { projects: [], all: [], scoped: [workflow("w-empty", "Empty draft", 0), workflow("w-full", "Vessel density", 2)] };
    const html = renderToStaticMarkup(<SignedIn account={bo}><WorkflowsScreen /></SignedIn>);
    expect(pictureOf(html, "Empty draft")).toBe("placeholder");
    expect(pictureOf(html, "Vessel density")).toBe("graph");
  });
});

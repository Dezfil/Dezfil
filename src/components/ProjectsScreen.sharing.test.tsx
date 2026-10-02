import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectsWorld } from "./projects/read";
import type { ProjectOverview } from "./projects/model";
import { ProjectsScreen } from "./ProjectsScreen";

/**
 * The Projects page's people chip, beside the published chip: the people
 * glyph with a count on a project one shares, the owner and one's role on a
 * project shared with one, nothing on a project only its owner reaches. A
 * project someone else owns offers Export alone; renaming and dissolving
 * stay its owner's.
 */

const view = vi.hoisted(() => ({ value: "grid" as "grid" | "list", peopleAsked: [] as string[][] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./use-view-prefs", () => ({
  useViewPrefs: () => ({ view: view.value, sort: "updated", setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("./sharing/use-project-people", () => ({
  useProjectPeople: (ids: string[]) => {
    view.peopleAsked.push([...ids]);
    return new Map([["port", [
      { name: "Bo Lindqvist", sqlName: "bo", role: "owner", deactivated: false },
      { name: "Ada Okafor", sqlName: "ada", role: "editor", deactivated: false },
      { name: "Cy Marsh", sqlName: "cy", role: "viewer", deactivated: false },
    ]]]);
  },
}));
const world = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./projects/read", () => ({
  useProjectsWorld: () => ({
    state: { status: "ready", value: world.value },
    retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn(),
  }),
}));

afterEach(() => { view.peopleAsked = []; });

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const ada = { name: "Ada Okafor", sqlName: "ada" };
const project = (id: string, name: string, role: ProjectOverview["role"], owner: typeof bo, published = 0): ProjectOverview => ({
  id, name, note: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  mapCount: 1, publishedMapCount: published, recipeCount: 0, tableCount: 0, sizeBytes: 0, sizeComplete: true,
  role, owner,
});
world.value = {
  projects: [
    project("port", "Port traffic", "owner", bo, 1),
    project("quay", "Quay survey", "owner", bo),
    project("berlin", "Berlin housing study", "editor", ada),
  ],
  maps: [], workflows: [], tables: [],
} satisfies ProjectsWorld;

describe.each(["grid", "list"] as const)("the Projects page's people chip (%s)", (layout) => {
  const render = () => {
    view.value = layout;
    return renderToStaticMarkup(<ProjectsScreen />);
  };

  it("counts the people of a project one shares and names them on hover", () => {
    const html = render();
    expect(html).toContain('data-people="sharing"');
    expect(html).toContain('data-hint="Shared with Ada and Cy"');
  });

  it("names the owner and one's role on a project shared with one", () => {
    expect(render()).toContain("by Ada · Editor");
  });

  it("reads people only for the projects one owns, and marks the unshared one with nothing", () => {
    const html = render();
    expect(view.peopleAsked.at(-1)).toEqual(["port", "quay"]);
    expect(html.match(/data-people=/g)).toHaveLength(2);
  });

  it("offers only Export on a project someone else owns", () => {
    const html = render();
    expect(html).toContain('aria-label="Export Berlin housing study"');
    expect(html).not.toContain('aria-label="Rename Berlin housing study"');
    expect(html).not.toContain('aria-label="Delete Berlin housing study"');
    expect(html).toContain('aria-label="Rename Port traffic"');
    expect(html).toContain('aria-label="Delete Port traffic"');
  });
});

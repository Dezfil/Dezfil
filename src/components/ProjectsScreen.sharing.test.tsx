import { act, useState } from "react";
import { useDepartureNotice } from "./projects/departure-notice";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectsWorld } from "./projects/read";
import type { ProjectOverview } from "./projects/model";
import { SignedIn } from "./sharing/signed-in";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { ProjectsScreen } from "./ProjectsScreen";

/**
 * The Projects page's people chip, beside the published chip: the people
 * glyph with a count on a project one shares, the owner and one's role on a
 * project shared with one, nothing on a project only its owner reaches. A
 * project someone else owns offers Export and Leave; renaming, sharing and
 * dissolving stay its owner's. The owner's Share action opens the share
 * dialog on that project, and a hand-over made there is said on the page.
 */

const view = vi.hoisted(() => ({ value: "grid" as "grid" | "list", peopleAsked: [] as string[][] }));
const spies = vi.hoisted(() => ({ push: vi.fn(), invalidateProjects: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: spies.push }) }));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./use-view-prefs", () => ({
  useViewPrefs: () => ({ view: view.value, sort: "updated", setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./shell/use-project-name", () => ({ invalidateProjects: spies.invalidateProjects }));
vi.mock("./sharing/use-project-people", async (original) => ({
  ...await original<typeof import("./sharing/use-project-people")>(),
  useProjectPeople: (ids: string[]) => {
    view.peopleAsked.push([...ids]);
    return new Map([["port", [
      { name: "Bo Lindqvist", sqlName: "bo", role: "owner", deactivated: false },
      { name: "Ada Okafor", sqlName: "ada", role: "editor", deactivated: false },
      { name: "Cy Marsh", sqlName: "cy", role: "viewer", deactivated: false },
    ]]]);
  },
}));
// The share dialog's menus as inline lists, so their items can be pressed
// in the node host.
vi.mock("./ui/Menu", () => ({
  Menu: ({ children, label, triggerLabel, trigger }: { children: React.ReactNode; label: string; triggerLabel?: string; trigger: React.ReactNode }) => (
    <div data-menu={label}>
      <button type="button" aria-label={triggerLabel ?? label}>{trigger}</button>
      {children}
    </div>
  ),
  MenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={onSelect}>{children}</button>
  ),
}));
const world = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./projects/read", () => ({
  useProjectsWorld: () => ({
    state: { status: "ready", value: world.value },
    retry: vi.fn(), mutate: vi.fn(), refresh: spies.refresh,
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

  it("offers Export then Leave on a project someone else owns", () => {
    const html = render();
    expect(html).toContain('aria-label="Export Berlin housing study"');
    expect(html).toContain('aria-label="Leave Berlin housing study"');
    expect(html.indexOf('aria-label="Export Berlin housing study"')).toBeLessThan(html.indexOf('aria-label="Leave Berlin housing study"'));
    expect(html).not.toContain('aria-label="Leave Port traffic"');
    expect(html).not.toContain('aria-label="Leave Quay survey"');
    expect(html).not.toContain('aria-label="Rename Berlin housing study"');
    expect(html).not.toContain('aria-label="Delete Berlin housing study"');
    expect(html).toContain('aria-label="Rename Port traffic"');
    expect(html).toContain('aria-label="Delete Port traffic"');
  });

  it("offers Share between Export and Delete on a project one owns, and not on one shared with one", () => {
    const html = render();
    const share = /<button[^>]*aria-label="Share Port traffic"[^>]*>/.exec(html);
    expect(share).not.toBeNull();
    expect(share?.[0]).toContain('data-hint="Share project"');
    expect(share?.[0]).toContain("data-share-action");
    expect(html.indexOf('aria-label="Export Port traffic"')).toBeLessThan(share!.index);
    expect(share!.index).toBeLessThan(html.indexOf('aria-label="Delete Port traffic"'));
    expect(html).not.toContain('aria-label="Share Berlin housing study"');
  });
});

describe.each(["grid", "list"] as const)("sharing from the Projects page (%s)", (layout) => {
  const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  let calls: string[];
  let host: ReturnType<typeof installDomHost>;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    view.value = layout;
    calls = [];
    spies.push.mockClear();
    spies.invalidateProjects.mockClear();
    spies.refresh.mockClear();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input === "/api/projects/port/people") {
        return answer(200, { people: [
          { name: "Bo Lindqvist", sqlName: "bo", role: "owner", deactivated: false },
          { name: "Ada Okafor", sqlName: "ada", role: "editor", deactivated: false },
        ] });
      }
      if (input === "/api/projects/berlin/leave") return answer(200, { left: true });
      if (input === "/api/projects/port/transfer") return answer(200, { id: "port", owner: ada });
      throw new Error(`unexpected ${init?.method ?? "GET"} ${input}`);
    }));
    host = installDomHost();
    const container = host.document.createElement("div");
    host.document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.uninstall();
    vi.unstubAllGlobals();
  });

  const q = (selector: string) => host.document.querySelector(selector);
  const button = (label: string) => host.document.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === label);
  const click = (el: HostElement | null | undefined) => act(async () => { el!.click(); await new Promise((r) => setTimeout(r, 0)); });
  const mount = () => act(async () => {
    root.render(<SignedIn account={bo}><ProjectsScreen /></SignedIn>);
  });

  it("carries the home departure notice for one Projects visit", async () => {
    function Visit() {
      const { remember } = useDepartureNotice();
      const [projects, show] = useState(false);
      return <><button onClick={() => { remember("You left Berlin housing study."); show(true); }}>Arrive</button>
        <button onClick={() => show(value => !value)}>Navigate</button>{projects && <ProjectsScreen />}</>;
    }
    await act(async () => root.render(<SignedIn account={bo}><Visit /></SignedIn>));
    const press = (name: string) => click(host.document.querySelectorAll("button").find(b => b.textContent === name));
    await press("Arrive");
    expect(q('p[role="status"]')?.textContent).toBe("You left Berlin housing study.");
    await press("Navigate"); await press("Navigate");
    expect(q('p[role="status"]')).toBeNull();
  });

  it("opens Leave without navigation, cancels without a request, then reports the departure", async () => {
    await mount();
    await click(button("Leave Berlin housing study"));
    expect(q('[role="dialog"]')?.textContent).toContain("Its owner can add you again.");
    expect(calls).not.toContain("POST /api/projects/berlin/leave");
    expect(spies.push).not.toHaveBeenCalled();
    await click(host.document.querySelectorAll("button").find(b => b.textContent === "Cancel"));
    expect(q('[role="dialog"]')).toBeNull();
    expect(calls).not.toContain("POST /api/projects/berlin/leave");
    await click(button("Leave Berlin housing study"));
    await click(host.document.querySelectorAll("button").find(b => b.textContent === "Leave project"));
    expect(calls.filter(c => c === "POST /api/projects/berlin/leave")).toHaveLength(1);
    expect(q('[role="dialog"]')).toBeNull();
    expect(q('p[role="status"]')?.textContent).toBe("You left Berlin housing study.");
    expect(spies.invalidateProjects).toHaveBeenCalled();
    expect(spies.refresh).toHaveBeenCalled();
  });

  it("moves focus to search after a departure, only once the confirmation has released the page", async () => {
    await mount();
    const search = q('input[aria-label="Search projects"]')!;
    // The node host focuses whatever it is asked to; a browser ignores a
    // focus call on an element that is still inert behind a dialog.
    const inertWhenAsked: boolean[] = [];
    const focus = search.focus.bind(search);
    search.focus = () => { inertWhenAsked.push(search.closest("[inert]") !== null); focus(); };
    button("Leave Berlin housing study")!.focus();
    await click(button("Leave Berlin housing study"));
    expect(search.closest("[inert]")).not.toBeNull();
    // Two turns of the timer queue inside one act, so anything the departure
    // defers by a timer runs before React commits the closing render: the
    // order a browser produces.
    await act(async () => {
      host.document.querySelectorAll("button").find(b => b.textContent === "Leave project")!.click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(q('[role="dialog"]')).toBeNull();
    expect(search.closest("[inert]")).toBeNull();
    expect(inertWhenAsked).toEqual([false]);
    expect(host.document.activeElement).toBe(search);
  });

  it("opens the share dialog on that project from its Share action, without opening the project", async () => {
    await mount();
    expect(q("[data-share-dialog]")).toBeNull();
    await click(button("Share Port traffic"));
    expect(q("[data-share-dialog]")?.getAttribute("aria-label")).toBe("Share Port traffic");
    expect(q("[data-share-dialog]")?.textContent).toContain("Port traffic");
    expect(calls).toContain("GET /api/projects/port/people");
    expect(spies.push).not.toHaveBeenCalled();
  });

  it("says in the dialog what the card counts: workflows by the listing, not the overview's recipe count", async () => {
    const shown = world.value as ProjectsWorld;
    world.value = {
      ...shown,
      projects: shown.projects.map((p) => (p.id === "port" ? { ...p, recipeCount: 4, tableCount: 2 } : p)),
    };
    try {
      await mount();
      await click(button("Share Port traffic"));
      expect(q("[data-share-dialog]")?.textContent).toContain("People get everything in it: 1 map, 2 datasets.");
    } finally {
      world.value = shown;
    }
  });

  it("says a hand-over in the page's status line and re-reads the projects", async () => {
    await mount();
    await click(button("Share Port traffic"));
    const ownerMenu = q('[data-member="bo"]')!.querySelector("[data-menu]")!;
    await click(ownerMenu.querySelector('[role="menuitem"]'));
    await click(q("[data-hand-over-confirm]"));
    expect(calls).toContain("POST /api/projects/port/transfer");
    expect(q("[data-share-dialog]")).toBeNull();
    expect(q('p[role="status"]')?.textContent).toBe("Ada Okafor owns Port traffic now.");
    expect(spies.invalidateProjects).toHaveBeenCalled();
    expect(spies.refresh).toHaveBeenCalled();
  });
});

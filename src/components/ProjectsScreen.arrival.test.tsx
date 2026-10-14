import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectsWorld } from "./projects/read";
import type { ProjectOverview } from "./projects/model";
import { SignedIn } from "./sharing/signed-in";
import { installDomHost } from "./testing/dom-host";
import { ProjectsScreen } from "./ProjectsScreen";

/**
 * Arriving on the Projects page for an account whose saved view is list.
 * The projects are already read; the stored view preference is held open.
 * Until it answers the page draws neither view: no grid card, no list row,
 * the list's own pending line, and neither toggle pressed. Then the list.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./sharing/use-project-people", async (original) => ({
  ...(await original<typeof import("./sharing/use-project-people")>()),
  useProjectPeople: () => new Map(),
}));
const world = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./projects/read", () => ({
  useProjectsWorld: () => ({
    state: { status: "ready", value: world.value },
    retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn(async () => {}),
  }),
}));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const project = (id: string, name: string): ProjectOverview => ({
  id, name, note: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  mapCount: 1, publishedMapCount: 0, recipeCount: 0, tableCount: 0, sizeBytes: 0, sizeComplete: true,
  role: "owner", owner: bo,
});
world.value = {
  projects: [project("port", "Port traffic"), project("quay", "Quay survey")],
  maps: [], workflows: [], tables: [],
} satisfies ProjectsWorld;

let release: () => void;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  const stored = new Promise<Response>((resolve) => {
    release = () => resolve(Response.json({ viewPrefs: { projects: { view: "list", sort: "updated" } } }));
  });
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if (input === "/api/settings" && !init?.method) return stored;
    return Promise.resolve(Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 }));
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

async function flush() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const all = (selector: string) => host.document.querySelectorAll(selector);
const toggle = (label: string) => all("button").find((b) => b.getAttribute("aria-label") === label);

describe("the Projects page before its saved list view arrives", () => {
  it("draws no grid card and presses neither view, then shows the list", async () => {
    await act(async () => root.render(<SignedIn account={bo}><ProjectsScreen /></SignedIn>));
    await flush();
    expect(all("article"), "no grid card before the stored view is known").toHaveLength(0);
    expect(all("[data-row-name]"), "nor a list row").toHaveLength(0);
    expect(all('p[role="status"]').some((p) => p.textContent === "Reading your projects…")).toBe(true);
    expect(toggle("Grid view")?.getAttribute("data-on"), "grid is not pressed").toBeNull();
    expect(toggle("List view")?.getAttribute("data-on"), "nor is list").toBeNull();

    release();
    await flush();
    expect(all("article"), "the saved list view, not the grid").toHaveLength(0);
    expect(all("[data-row-name]").map((n) => n.textContent)).toEqual(["Port traffic", "Quay survey"]);
    expect(toggle("List view")?.getAttribute("data-on")).toBe("true");
    expect(toggle("Grid view")?.getAttribute("data-on")).toBeNull();
  });
});

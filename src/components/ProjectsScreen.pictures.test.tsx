import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectsWorld } from "./projects/read";
import type { ProjectOverview } from "./projects/model";
import { SignedIn } from "./sharing/signed-in";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { ProjectsScreen } from "./ProjectsScreen";

/**
 * The Projects page's map pictures: the line an administrator is handed
 * when pictures have no renderer stands at the page's foot, under the
 * projects, in either view, and nowhere when the page does not hand it.
 * The composed read is a fake.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The line's one link is a plain anchor here, standing in for next/link's.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./sharing/use-project-people", async (original) => ({
  ...(await original<typeof import("./sharing/use-project-people")>()),
  useProjectPeople: () => new Map(),
}));
const fake = vi.hoisted(() => ({ world: null as unknown, view: "grid" as "grid" | "list" }));
vi.mock("./projects/read", () => ({
  useProjectsWorld: () => ({
    state: { status: "ready", value: fake.world },
    retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn(async () => {}),
  }),
}));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: fake.view, sort: "updated", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./MapStrip", () => ({ MapStrip: () => null }));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const project = (id: string, name: string): ProjectOverview => ({
  id, name, note: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  mapCount: 1, publishedMapCount: 0, recipeCount: 0, tableCount: 0, sizeBytes: 0, sizeComplete: true,
  role: "owner", owner: bo,
});

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(() => {
  fake.view = "grid";
  fake.world = { projects: [project("port", "Port traffic")], maps: [], workflows: [], tables: [] } satisfies ProjectsWorld;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function open(rendererNotice?: boolean) {
  await act(async () => root.render(<SignedIn account={bo}><ProjectsScreen rendererNotice={rendererNotice} /></SignedIn>));
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const notices = () => container.querySelectorAll("[data-renderer-notice]");
const screen = () => container.childNodes[0] as HostElement;

describe("the Projects page's line for an administrator when pictures have no renderer", () => {
  it.each(["grid", "list"] as const)("stands under the projects' scroller in the %s view", async (view) => {
    fake.view = view;
    await open(true);
    expect(notices()).toHaveLength(1);
    const [line] = notices();
    expect(line.parentElement).toBe(screen());
    const before = screen().childNodes[screen().childNodes.indexOf(line) - 1] as HostElement;
    expect(before.textContent).toContain("Port traffic");
    expect(line.textContent).toBe("No map pictures: this instance has no renderer. Settings · System says how to set one.");
  });

  it.each([false, undefined])("is not there when the page does not hand it (%s)", async (handed) => {
    await open(handed);
    expect(notices()).toHaveLength(0);
  });
});

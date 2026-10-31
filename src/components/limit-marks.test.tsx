import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { ListHeading } from "./ListHeading";
import { MapsScreen } from "./MapsScreen";
import { ProjectsScreen } from "./ProjectsScreen";
import { SignedIn } from "./sharing/signed-in";
import { HostEvent, installDomHost, type HostElement } from "./testing/dom-host";
import { limitMark } from "./use-instance-rules";
import { UsersScreen } from "./users/UsersScreen";

/**
 * The count mark beside the Maps, Projects and Users headings: "n of m" from
 * the runtime read while a limit is set, and nothing otherwise, the heading's
 * own name unchanged. It follows the list, and a refused creation, by reading
 * the count again. The runtime read and the lists' worlds are fakes.
 */

const worlds = vi.hoisted(() => ({ maps: null as unknown, projects: null as unknown }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "edited", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: worlds.maps }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("./sharing/use-project-people", async (original) => ({
  ...(await original<typeof import("./sharing/use-project-people")>()),
  useProjectPeople: () => new Map(),
}));
vi.mock("./projects/read", () => ({
  useProjectsWorld: () => ({ state: { status: "ready", value: worlds.projects }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn(async () => {}) }),
}));

const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const base = { sqlName: "x", isAdmin: false, isOriginal: false, createdAt: "2026-01-01", updatedAt: "2026-01-01", lastSignInAt: null };
const ME: Account = { ...base, id: "me", name: "Me Self", email: "me@example.test", status: "active", isAdmin: true };
const REFUSED = "This instance holds its limit of 20 people. Delete one, or raise the limit.";
const reading = (limit: number, count: number) => ({ limit, count });

let limits: Record<string, { limit: number; count: number }> | null;
let answers: Record<string, () => Response>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  limits = { maps: reading(0, 3), projects: reading(0, 3), people: reading(0, 3) };
  answers = {};
  worlds.maps = { projects: [], all: [], scoped: [] };
  worlds.projects = { projects: [], maps: [], workflows: [], tables: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input), key = `${init.method ?? "GET"} ${url}`;
    if (answers[key]) return answers[key]();
    if (url === "/api/config") {
      return limits ? Response.json({ instanceLimits: limits, rules: {}, externalSignIn: { enabled: false } }) : Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 });
    }
    if (url === "/api/account") return Response.json({ account: ME });
    if (url === "/api/users") return Response.json({ users: [ME], deletions: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
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

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function draw(screen: ReactNode) {
  await act(async () => root.render(<SignedIn account={bo}>{screen}</SignedIn>));
  await settle();
}
const heading = () => container.querySelector("[data-list-heading]")!;
const mark = () => heading().querySelector("[data-limit-mark]")?.textContent ?? null;
const title = () => heading().querySelector("h1")!.textContent;
const button = (words: string) => container.querySelectorAll("button").find(each => each.textContent?.includes(words))!;

describe("the mark's words", () => {
  it("says n of m while a limit is set, grouped, even past the limit, and nothing otherwise", () => {
    expect(limitMark(reading(20, 3))).toBe("3 of 20");
    expect(limitMark(reading(20, 25))).toBe("25 of 20");
    expect(limitMark(reading(2000, 1250))).toBe("1,250 of 2,000");
    expect(limitMark(reading(20, 0))).toBe("0 of 20");
    expect(limitMark(reading(0, 3))).toBeNull();
    expect(limitMark(undefined)).toBeNull();
  });
});

describe("the heading", () => {
  it("draws the mark it is given beside the title, outside it, and none otherwise", async () => {
    await draw(<ListHeading title="Tables" line={null} />);
    expect(mark()).toBeNull();
    await draw(<ListHeading title="Tables" line={null} mark="3 of 20" />);
    expect(mark()).toBe("3 of 20");
    expect(title()).toBe("Tables");
  });
});

describe.each([
  ["Maps", "maps", () => <MapsScreen />],
  ["Projects", "projects", () => <ProjectsScreen />],
  ["Users", "people", () => <UsersScreen />],
] as const)("%s", (name, of, screen) => {
  it("shows n of m beside its heading while the limit is set", async () => {
    limits![of] = reading(20, 3);
    await draw(screen());
    expect(mark()).toBe("3 of 20");
    expect(title()).toBe(name);
  });

  it("shows no mark with no limit set, and none when the read fails", async () => {
    await draw(screen());
    expect(mark()).toBeNull();
    limits = null;
    await act(async () => root.unmount());
    root = createRoot(container as unknown as Element);
    await draw(screen());
    expect(mark()).toBeNull();
  });

  it("follows only its own limit", async () => {
    limits = { maps: reading(0, 3), projects: reading(0, 3), people: reading(0, 3), [of === "maps" ? "projects" : "maps"]: reading(20, 3) };
    await draw(screen());
    expect(mark()).toBeNull();
  });
});

describe("the mark after a change", () => {
  it("reads the count again when the Maps list changes", async () => {
    limits!.maps = reading(20, 3);
    worlds.maps = { projects: [], all: [{ id: "a" }, { id: "b" }, { id: "c" }], scoped: [] };
    await draw(<MapsScreen />);
    expect(mark()).toBe("3 of 20");
    limits!.maps = reading(20, 2);
    worlds.maps = { projects: [], all: [{ id: "a" }, { id: "b" }], scoped: [] };
    await draw(<MapsScreen />);
    expect(mark()).toBe("2 of 20");
  });

  it("reads the count again when a project's name is refused at the limit, in the dialog that asked", async () => {
    limits!.projects = reading(20, 19);
    await draw(<ProjectsScreen />);
    expect(mark()).toBe("19 of 20");
    limits!.projects = reading(20, 20);
    const sentence = "This instance holds its limit of 20 projects. Delete one, or raise the limit.";
    answers["POST /api/projects"] = () => Response.json({ error: { code: "instance_limit_reached", message: sentence, key: "projectsLimit", limit: 20, count: 20 } }, { status: 409 });
    await act(async () => { button("New project").click(); });
    const input = host.document.querySelectorAll("label").find(each => each.textContent?.startsWith("Name"))!.querySelector("input")!;
    const key = Object.keys(input).find(each => each.startsWith("__reactProps$"))!;
    await act(async () => (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key].onChange({ target: { value: "Port" } }));
    await act(async () => { host.document.querySelectorAll("button").find(each => each.textContent === "Create")!.click(); });
    await settle();
    expect(host.document.querySelectorAll('[role="alert"]').map(each => each.textContent)).toContain(sentence);
    expect(mark()).toBe("20 of 20");
  });

  it("reads the count again when New map is refused, keeps the button enabled and shows the sentence", async () => {
    limits!.maps = reading(20, 19);
    await draw(<MapsScreen />);
    expect(mark()).toBe("19 of 20");
    limits!.maps = reading(20, 20);
    const sentence = "This instance holds its limit of 20 maps. Delete one, or raise the limit.";
    answers["POST /api/maps"] = () => Response.json({ error: { code: "instance_limit_reached", message: sentence, key: "mapsLimit", limit: 20, count: 20 } }, { status: 409 });
    await act(async () => { button("New map").click(); });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(sentence);
    expect(button("New map").disabled).toBe(false);
    expect(mark()).toBe("20 of 20");
  });

  it("reads the count again when the Projects list changes", async () => {
    limits!.projects = reading(20, 0);
    await draw(<ProjectsScreen />);
    expect(mark()).toBe("0 of 20");
    limits!.projects = reading(20, 1);
    worlds.projects = { projects: [{ id: "p", name: "Port", mapCount: 0, publishedMapCount: 0, recipeCount: 0, tableCount: 0, sizeBytes: 0, sizeComplete: true, role: "owner", owner: bo }], maps: [], workflows: [], tables: [] };
    await draw(<ProjectsScreen />);
    expect(mark()).toBe("1 of 20");
  });

  it("reads the count again when an invitation lands or is refused", async () => {
    limits!.people = reading(20, 18);
    await draw(<UsersScreen />);
    expect(mark()).toBe("18 of 20");
    async function invite(email: string) {
      await act(async () => { button("Invite").click(); });
      for (const [label, value] of [["Name", "Cy Marsh"], ["Email", email]]) {
        const input = container.querySelectorAll("input").find(element => element.getAttribute("aria-label") === label)!;
        const key = Object.keys(input).find(each => each.startsWith("__reactProps$"))!;
        await act(async () => (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key].onChange({ target: { value } }));
      }
      await act(async () => { container.querySelector('form[aria-label="Invite user"]')!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
      await settle();
    }
    limits!.people = reading(20, 19);
    answers["POST /api/users"] = () => Response.json({ account: { ...ME, id: "cy", name: "Cy Marsh", email: "cy@example.test", status: "invited", isAdmin: false } }, { status: 201 });
    await invite("cy@example.test");
    expect(mark()).toBe("19 of 20");
    limits!.people = reading(20, 20);
    answers["POST /api/users"] = () => Response.json({ error: { code: "instance_limit_reached", message: REFUSED, key: "peopleLimit", limit: 20, count: 20 } }, { status: 409 });
    await invite("di@example.test");
    expect(container.querySelector('form[aria-label="Invite user"]')).not.toBeNull();
    expect(container.textContent).toContain(REFUSED);
    expect(mark()).toBe("20 of 20");
  });
});

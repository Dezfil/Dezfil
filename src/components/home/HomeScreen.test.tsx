import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateCard, TemplateList } from "@/lib/templates/card";
import type { MapOverview, TableListing } from "../api";
import { SignedIn } from "../sharing/signed-in";
import type { PersonLabel } from "../sharing/people";
import { installDomHost, type HostElement } from "../testing/dom-host";
import type { WorkflowListing } from "../workflow-model";
import { HomeScreen } from "./HomeScreen";

/**
 * Home's screen over fake reads answering through fetch, as the signed-in
 * account. Each list is read once, as its own state; a read can be held
 * to answer later or fail. The expected words, leads and requests are
 * written here, never read from the module under test.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: vi.fn() }) }));

const ADA: PersonLabel = { name: "Ada Lovelace", sqlName: "ada" };
const BO: PersonLabel = { name: "Bo Brandt", sqlName: "bo" };
const at = (d: number) => `2026-10-${String(d).padStart(2, "0")}T09:00:00.000Z`;

function map(id: string, f: { owner?: PersonLabel; by?: PersonLabel | null; changed?: string; project?: string | null } = {}): MapOverview {
  const owner = f.owner ?? ADA;
  const changed = f.changed ?? at(1);
  return JSON.parse(JSON.stringify({
    id, name: `Map ${id}`, projectId: f.project ?? null, owner, home: owner.sqlName,
    layerCount: 2, layerColors: [], published: false, publishToken: null,
    createdAt: at(1), updatedAt: changed, editRevision: `rev-${id}`,
    lastChangedAt: changed, lastChangedBy: f.by === undefined ? owner : f.by,
  })) as MapOverview;
}

function card(id: string, title: string): TemplateCard {
  return {
    id, kind: "map", version: 1, title, question: `What does ${title} show?`, place: "Hamburg",
    tags: ["First map", "3D", "Widgets"], dataDate: "2026",
    sources: [{ name: "OpenStreetMap", licence: "ODbL-1.0", credit: "© OpenStreetMap contributors" }],
    steps: null, origin: "shipped", installed: 1, listed: null, present: true, size: 1, picture: "kept",
  };
}

const TEMPLATES: TemplateList = {
  templates: [card("harbour", "Harbour depths"), card("trees", "Street trees"), card("storms", "Storm tracks")],
  catalogue: { state: "off", host: null, folder: false, readAt: null, reason: null, status: null },
  downloads: { versions: 0, bytes: 0 },
};

/** What each read answers; a function answers when the test says. */
type Answer = unknown | (() => Promise<Response>);
let answers: Record<string, Answer>;
let fetchSpy: ReturnType<typeof vi.fn>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const LISTS: Record<string, string> = {
  "/api/maps": "maps",
  "/api/recipes?origin=workflow": "workflows",
  "/api/tables": "tables",
  "/api/projects": "projects",
  "/api/templates": "templates",
};

beforeEach(() => {
  nav.push.mockReset();
  answers = {
    maps: [] as MapOverview[],
    workflows: { recipes: [] as WorkflowListing[] },
    tables: [] as TableListing[],
    projects: [],
    templates: TEMPLATES,
    operations: { operations: [] },
  };
  fetchSpy = vi.fn(async (input: string) => {
    const url = String(input);
    const key = LISTS[url] ?? (url === "/api/operations" ? "operations" : null);
    if (key === null) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    const answer = answers[key];
    return typeof answer === "function" ? (answer as () => Promise<Response>)() : Response.json(answer);
  });
  vi.stubGlobal("fetch", fetchSpy);
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
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function open(person: PersonLabel | null = ADA) {
  await act(async () => root.render(<SignedIn account={person}><HomeScreen /></SignedIn>));
  await settle();
}
const welcome = () => container.querySelectorAll("h1").map((h) => h.textContent);
const listCalls = () => fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url in LISTS);

describe("Home's welcome and reads", () => {
  it("greets the person by the first word of their display name, with no lead of their own yet", async () => {
    await open();
    expect(welcome()).toEqual(["Welcome, Ada"]);
  });

  it("says welcome back once their own last change leads", async () => {
    answers.maps = [map("m1")];
    await open();
    expect(welcome()).toEqual(["Welcome back, Ada"]);
  });

  it("greets without a name when the shell knows nobody, and a shared map changed by someone else is not the person's", async () => {
    answers.maps = [map("m1", { owner: BO, project: "p1" })];
    await open(null);
    expect(welcome()).toEqual(["Welcome"]);
  });

  it("reads each list once, as its own request", async () => {
    await open();
    expect(listCalls().sort()).toEqual([
      "/api/maps", "/api/projects", "/api/recipes?origin=workflow", "/api/tables", "/api/templates",
    ]);
  });
});

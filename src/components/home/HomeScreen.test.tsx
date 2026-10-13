import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateCard, TemplateList } from "@/lib/templates/card";
import type { MapOverview, TableListing } from "../api";
import { SignedIn } from "../sharing/signed-in";
import type { PersonLabel } from "../sharing/people";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
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
// The instance's name as the shell's one store holds it (the store's own
// read is held by its tests); a test names the instance here.
const instance = vi.hoisted(() => ({ name: null as string | null }));
vi.mock("../shell/path-model", async (original) => ({
  ...(await original<typeof import("../shell/path-model")>()),
  useInstanceName: () => instance.name,
}));
// A link as the browser holds it; the framework's prefetching needs a browser.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

/* The hosted dialogs are their own surfaces, held by their own tests: here
   they record what Home hands them. */
const hosted = vi.hoisted(() => ({
  copying: [] as string[],
  addData: null as null | {
    open: boolean;
    projectId?: string | null;
    onTableCreated: (table: unknown) => void;
    onPostgisTableCreated: (table: unknown) => void;
    onClose: () => void;
  },
  queue: null as null | { projectId?: string | null; onSettled?: (report: unknown) => void; onFileImported?: () => void },
}));
vi.mock("../templates/TemplateCopyDialog", () => ({
  TemplateCopyDialog: ({ id }: { id: string }) => {
    hosted.copying.push(id);
    return null;
  },
}));
vi.mock("../AddDataDialog", () => ({
  AddDataDialog: (props: NonNullable<typeof hosted.addData>) => {
    hosted.addData = props;
    return props.open ? <div data-add-data-dialog /> : null;
  },
}));
vi.mock("../use-upload-queue", () => ({
  useUploadQueue: (options: NonNullable<typeof hosted.queue>) => {
    hosted.queue = options;
    return { entries: [], settled: true, projectId: null, dismiss: () => 0, reset: () => {}, current: () => ({ settled: true }) };
  },
}));

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

function wf(
  id: string,
  f: { owner?: PersonLabel; by?: PersonLabel | null; changed?: string; project?: string | null; again?: number } = {},
): WorkflowListing {
  const owner = f.owner ?? ADA;
  const changed = f.changed ?? at(1);
  const again = f.again ?? 0;
  return JSON.parse(JSON.stringify({
    id, name: `Flow ${id}`, origin: "workflow", projectId: f.project ?? null, owner, home: owner.sqlName,
    createdAt: at(1), updatedAt: changed, editRevision: `rev-${id}`,
    lastChangedAt: changed, lastChangedBy: f.by === undefined ? owner : f.by,
    summary: { nodes: 3, sources: 1, liveOutputs: 1, status: again > 0 ? "run_again" : "up_to_date", count: again },
    steps: [],
  })) as WorkflowListing;
}

function table(id: string, f: { owner?: PersonLabel; imported?: string; projects?: string[] } = {}): TableListing {
  const owner = f.owner ?? ADA;
  return JSON.parse(JSON.stringify({
    id, name: `table_${id}`, qualifiedName: `table_${id}`, projectIds: f.projects ?? [], owner,
    rowCount: 10, geometryColumn: null, geometryType: null, sizeBytes: 100,
    createdAt: at(1), importedAt: f.imported ?? at(1),
  })) as TableListing;
}

/** A project as the projects list answers it, with how Ada stands to it. */
const project = (id: string, role: "owner" | "editor" | "viewer") =>
  ({ id, name: `Project ${id}`, role, createdAt: at(1), updatedAt: at(1) });

function card(id: string, title: string, more: Partial<TemplateCard> = {}): TemplateCard {
  return {
    id, kind: "map", version: 1, title, question: `What does ${title} show?`, place: "Hamburg",
    tags: ["First map", "3D", "Widgets"], dataDate: "2026",
    sources: [
      { name: "Hamburg Port Authority", licence: "CC-BY-4.0", credit: "Soundings courtesy of the Hamburg Port Authority." },
      { name: "OpenStreetMap", licence: "ODbL-1.0", credit: "© OpenStreetMap contributors" },
    ],
    steps: null, origin: "shipped", installed: 1, listed: null, present: true, size: 1, picture: "kept", ...more,
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
  instance.name = null;
  hosted.copying = [];
  hosted.addData = null;
  hosted.queue = null;
  answers = {
    maps: [] as MapOverview[],
    workflows: { recipes: [] as WorkflowListing[] },
    tables: [] as TableListing[],
    projects: [],
    templates: TEMPLATES,
    operations: { operations: [] },
  };
  fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return posts(url, init);
    const run = /^\/api\/recipes\/([^/]+)\/runs\/([^/]+)$/.exec(url);
    if (run) {
      const answer = answers[`run:${run[2]}`];
      return typeof answer === "function" ? (answer as () => Promise<Response>)() : Response.json(answer);
    }
    const runs = /^\/api\/recipes\/([^/]+)\/runs$/.exec(url);
    if (runs) {
      const answer = answers[`runs:${runs[1]}`] ?? { runs: [] };
      return typeof answer === "function" ? (answer as () => Promise<Response>)() : Response.json(answer);
    }
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

/** The creates Home sends: a new map, a new workflow. */
let posts: (url: string, init: RequestInit) => Promise<Response>;
beforeEach(() => {
  posts = async (url) => {
    if (url === "/api/maps") return Response.json({ id: "new-map" });
    if (url === "/api/recipes") return Response.json({ recipe: { id: "new-flow" } });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  };
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
const calls = (url: string, method = "GET") =>
  fetchSpy.mock.calls.filter(([u, init]) => String(u) === url && ((init as RequestInit | undefined)?.method ?? "GET") === method);
const headings = () => container.querySelectorAll("h2").map((h) => h.textContent);
const leadKind = () => container.querySelector("[data-lead]")?.getAttribute("data-lead") ?? null;
const leadPlace = () => container.querySelector("[data-lead]")!;
const field = (name: string) => leadPlace().querySelector(`[data-field="${name}"]`)?.textContent ?? null;
const start = () => container.querySelector("[data-start]")!;
const startActions = () => start().querySelectorAll("[data-start-action]").map((a) => a.textContent);
const button = (name: string) => container.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === name || b.textContent === name)!;
const named = (name: string) => container.querySelectorAll("[aria-label]").filter((e) => e.getAttribute("aria-label") === name);

/** A read answering only when the test releases it, or failing then. */
function held() {
  let release!: (response: Response) => void;
  const answer = () => new Promise<Response>((resolve) => { release = resolve; });
  return {
    answer,
    release: (body: unknown) => release(Response.json(body)),
    fail: (message = "The workflows couldn't be read.") => release(Response.json({ error: { code: "internal", message } }, { status: 500 })),
  };
}
async function press(element: HostElement) {
  await act(async () => { element.click(); });
  await settle();
}

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

  it("greets without a name when the shell knows nobody", async () => {
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

describe("the lead", () => {
  it("leads a person who reaches nothing with the first template, wide, its mark, place, sources, title, question, two tags and both actions", async () => {
    await open();
    expect(leadKind()).toBe("template");
    expect(headings()).toEqual(["Start with a template", "Or start your own"]);
    expect(field("mark")).toBe("Template");
    expect(field("place")).toBe("Hamburg");
    expect(field("sources")).toBe("Hamburg Port Authority · OpenStreetMap");
    expect(field("title")).toBe("Harbour depths");
    expect(field("question")).toBe("What does Harbour depths show?");
    expect(leadPlace().querySelector('[data-field="tags"]')!.querySelectorAll("span").map((t) => t.textContent)).toEqual(["First map", "3D"]);
    expect(leadPlace().querySelector("img")?.getAttribute("src")).toBe("/api/templates/harbour/picture?v=1&theme=light");
    // The lead is one link named for the template, then Open and Make a copy, the copy the primary.
    expect(named("Open Harbour depths").map((e) => e.getAttribute("role") ?? e.tagName.toLowerCase())).toEqual(["link", "button"]);
    expect(button("Open Harbour depths").textContent).toBe("Open");
    expect(button("Make a copy of Harbour depths").textContent).toBe("Make a copy");
    expect(button("Make a copy of Harbour depths").getAttribute("data-variant")).toBe("primary");
    expect(button("Open Harbour depths").getAttribute("data-variant")).not.toBe("primary");
  });

  it("opens the template's page from the card and from Open, and hands Make a copy its id", async () => {
    await open();
    await press(named("Open Harbour depths")[0]);
    expect(nav.push).toHaveBeenLastCalledWith("/templates/harbour");
    nav.push.mockReset();
    await press(button("Open Harbour depths"));
    expect(nav.push).toHaveBeenCalledWith("/templates/harbour");
    expect(hosted.copying).toEqual([]);
    await press(button("Make a copy of Harbour depths"));
    expect(hosted.copying.at(-1)).toBe("harbour");
  });

  it("draws a workflow example's lead as its graph, not a picture", async () => {
    answers.templates = { ...TEMPLATES, templates: [card("reach", "Market reach", {
      kind: "workflow", picture: "not_kept",
      steps: [{ id: "near", operation: "nearest", output: "block_nearest", reads: ["blocks", "markets"] }],
    }), ...TEMPLATES.templates] };
    await open();
    expect(field("title")).toBe("Market reach");
    expect(leadPlace().querySelector("img")).toBeNull();
    expect(leadPlace().querySelectorAll("svg").some((svg) => svg.getAttribute("viewBox") === "0 0 280 92")).toBe(true);
  });

  it("leads with the person's own last change as Continue, the taller card with its picture, and Start beside it", async () => {
    answers.maps = [map("m1")];
    await open();
    expect(leadKind()).toBe("continue");
    expect(headings()).toEqual(["Continue", "Start"]);
    const card = named("Open Map m1")[0];
    expect(card.getAttribute("role")).toBe("link");
    // The picture is the card's sized strip, taller than a project home's 112.
    const strip = card.descendants().find((e) => e.style.height !== undefined);
    expect(Number.parseInt(String(strip?.style.height), 10)).toBeGreaterThan(112);
    expect(leadPlace().querySelector("[data-owner-pill]")).toBeNull();
    expect(field("title")).toBeNull();
    await press(card);
    expect(nav.push).toHaveBeenCalledWith("/maps/m1");
  });

  it("puts a shared workflow the person changed last in Continue wearing its owner, its run read once", async () => {
    answers.maps = [map("m1", { changed: at(1) })];
    answers.workflows = { recipes: [wf("w1", { owner: BO, by: ADA, changed: at(3), project: "p1" })] };
    answers["runs:w1"] = { runs: [] };
    await open();
    expect(leadKind()).toBe("continue");
    expect(named("Open Flow w1")).toHaveLength(1);
    expect(leadPlace().querySelector("[data-owner-pill]")?.getAttribute("aria-label")).toBe("Shared by Bo Brandt");
    expect(leadPlace().textContent).toContain("Never run");
    expect(calls("/api/recipes/w1/runs")).toHaveLength(1);
  });

  it("shows the glyph on a workflow's card while its run is read, never Never run", async () => {
    answers.workflows = { recipes: [wf("w1")] };
    const runs = held();
    answers["runs:w1"] = runs.answer;
    await open();
    expect(leadKind()).toBe("continue");
    expect(leadPlace().textContent).not.toContain("Never run");
    expect(leadPlace().textContent).toContain("—");
    runs.release({ runs: [] });
    await settle();
    expect(leadPlace().textContent).toContain("Never run");
  });

  it("gives a newcomer who reaches shared work but changed none of it the template lead", async () => {
    answers.maps = [map("m1", { owner: BO, project: "p1" })];
    answers.workflows = { recipes: [wf("w1", { owner: BO, project: "p1" })] };
    await open();
    expect(leadKind()).toBe("template");
    expect(container.querySelectorAll("h1").map((h) => h.textContent)).toEqual(["Welcome, Ada"]);
  });

  it("stands the four start actions in one row under the welcome when nothing leads", async () => {
    answers.templates = { ...TEMPLATES, templates: [] };
    await open();
    expect(leadKind()).toBeNull();
    expect(headings()).toEqual(["Start"]);
    expect(start().getAttribute("data-start-form")).toBe("row");
    expect(startActions()).toEqual(["New map", "Add data", "New workflow", "Open SQL"]);
  });

  it("leaves no lead when the template list failed and nothing of the person's leads", async () => {
    answers.templates = () => Promise.resolve(Response.json({ error: { code: "internal", message: "No." } }, { status: 500 }));
    await open();
    expect(leadKind()).toBeNull();
    expect(start().getAttribute("data-start-form")).toBe("row");
  });
});

describe("the lead waits for both the maps and the workflows", () => {
  it("puts neither a template nor Continue in the lead's place while the workflows are read, then their failure with Try again", async () => {
    answers.maps = [map("m1", { changed: at(1) })];
    const workflows = held();
    answers.workflows = workflows.answer;
    await open();
    // Pending: the shipped pending line where the lead goes, no template, no Continue.
    expect(leadKind()).toBe("pending");
    expect(leadPlace().querySelector('[role="status"]')).not.toBeNull();
    expect(named("Open Harbour depths")).toEqual([]);
    expect(named("Open Map m1")).toEqual([]);
    expect(headings()).not.toContain("Start with a template");
    expect(headings()).not.toContain("Continue");
    expect(start().getAttribute("data-start-form")).toBe("pair");
    expect(startActions()).toEqual(["New map", "Add data", "New workflow", "Open SQL"]);

    workflows.fail();
    await settle();
    expect(leadKind()).toBe("failed");
    expect(leadPlace().querySelector('[role="alert"]')?.textContent).toContain("The workflows couldn't be read.");
    expect(named("Open Harbour depths")).toEqual([]);
    expect(named("Open Map m1")).toEqual([]);
    expect(startActions()).toEqual(["New map", "Add data", "New workflow", "Open SQL"]);

    // Try again asks the workflows alone again, and the expected lead stands.
    answers.workflows = { recipes: [wf("w2", { changed: at(3) })] };
    const before = calls("/api/maps").length;
    await press(button("Try again"));
    expect(calls("/api/recipes?origin=workflow")).toHaveLength(2);
    expect(calls("/api/maps")).toHaveLength(before);
    expect(leadKind()).toBe("continue");
    expect(named("Open Flow w2")).toHaveLength(1);
  });

  it("brings the template lead after Try again when the person has no change of their own", async () => {
    answers.workflows = () => Promise.resolve(Response.json({ error: { code: "internal", message: "The workflows couldn't be read." } }, { status: 500 }));
    await open();
    expect(leadKind()).toBe("failed");
    expect(named("Open Harbour depths")).toEqual([]);
    answers.workflows = { recipes: [] };
    await press(button("Try again"));
    expect(leadKind()).toBe("template");
    expect(named("Open Harbour depths")).toHaveLength(2);
  });
});

describe("Start", () => {
  it("offers the four start actions two by two beside the lead", async () => {
    await open();
    expect(start().getAttribute("data-start-form")).toBe("pair");
    expect(startActions()).toEqual(["New map", "Add data", "New workflow", "Open SQL"]);
    const sql = start().querySelector('[data-start-action="sql"]')!;
    expect(sql.tagName).toBe("A");
    expect(sql.getAttribute("href")).toBe("/sql");
  });

  it("makes one unfiled map with the instance's defaults under a double press, and opens the builder on it", async () => {
    let answer!: (response: Response) => void;
    posts = (url) => (url === "/api/maps" ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve(Response.json({})));
    await open();
    const tile = start().querySelector('[data-start-action="new-map"]')!;
    await act(async () => { tile.click(); tile.click(); });
    await settle();
    await act(async () => { tile.click(); });
    expect(calls("/api/maps", "POST")).toHaveLength(1);
    expect(JSON.parse(String((calls("/api/maps", "POST")[0][1] as RequestInit).body))).toEqual({ name: "Untitled map" });
    answer(Response.json({ id: "new-map" }));
    await settle();
    expect(nav.push).toHaveBeenCalledWith("/maps/new-map");
  });

  it("opens Add data on Home, filed nowhere, and re-reads the datasets when a table lands or a batch settles", async () => {
    await open();
    expect(hosted.addData?.open).toBe(false);
    expect(hosted.queue?.projectId).toBeNull();
    await press(start().querySelector('[data-start-action="add-data"]')!);
    expect(hosted.addData?.open).toBe(true);
    expect(hosted.addData?.projectId ?? null).toBeNull();
    expect(calls("/api/tables")).toHaveLength(1);
    await act(async () => { hosted.addData!.onTableCreated({ name: "stations" }); });
    await settle();
    expect(calls("/api/tables")).toHaveLength(2);
    expect(hosted.addData?.open).toBe(false);
    await act(async () => {
      hosted.queue!.onSettled!({ tables: [{ name: "parcels" }], files: 1, failed: 0, unconfirmed: 0, notStarted: 0, entries: [], skips: [] });
    });
    await settle();
    expect(calls("/api/tables")).toHaveLength(3);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("opens the New workflow dialog for an unfiled workflow, then the canvas on it", async () => {
    await open();
    await press(start().querySelector('[data-start-action="new-workflow"]')!);
    const dialog = host.document.body.querySelector('[aria-label="New workflow"]')!;
    expect(dialog).not.toBeNull();
    await press(dialog.querySelectorAll("button").find((b) => b.textContent === "Create")!);
    const sent = calls("/api/recipes", "POST");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String((sent[0][1] as RequestInit).body))).toEqual({ name: "Untitled workflow", origin: "workflow" });
    expect(nav.push).toHaveBeenCalledWith("/workflows/new-flow");
  });
});

/** A read answering its calls in turn: each step answers one call, a
 * function step when the test says, and the last step every later call. */
function inTurn(...steps: unknown[]) {
  let n = 0;
  return () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    return typeof step === "function" ? (step as () => Promise<Response>)() : Promise.resolve(Response.json(step));
  };
}
const failing = (message: string) => () => Promise.resolve(Response.json({ error: { code: "internal", message } }, { status: 500 }));
const row = (id: string) => container.querySelector(`[data-attention="${id}"]`);
const runButton = (id: string) => row(id)?.querySelectorAll("button").find((b) => b.getAttribute("aria-label")?.startsWith("Run ")) ?? null;
const alerts = () => container.querySelectorAll('[role="alert"]').map((a) => a.querySelector("p")?.textContent ?? "");
const recentRows = () => container.querySelectorAll("[data-recent-row]");
const recentNames = () => recentRows().map((r) => r.getAttribute("aria-label"));
const metaOf = (name: string) =>
  recentRows().find((r) => r.getAttribute("aria-label")?.startsWith(name))?.querySelector("[data-recent-meta]") ?? null;
const runsReads = () => fetchSpy.mock.calls.map(([url, init]) => [String(url), (init as RequestInit | undefined)?.method ?? "GET"])
  .filter(([url, method]) => method === "GET" && /^\/api\/recipes\/[^/]+\/runs$/.test(url));

/** A run of Ada's workflow w1: the plan, narrow unless asked wide, then the
 * run the start answers with, then the run as the poll reads it, settled. */
const RUN = { id: "r1", recipeId: "w1", kind: "single", outcome: null, cancelled: false, startedAt: at(9), finishedAt: null, members: [] };
const SETTLED = { ...RUN, outcome: "succeeded", finishedAt: at(9) };
function runsOf(id: string, plan: { wide: boolean; members: string[] } = { wide: false, members: ["a"] }) {
  const sent: unknown[] = [];
  posts = async (url, init) => {
    const body = JSON.parse(String(init.body ?? "null")) as { plan?: boolean } | null;
    if (url !== `/api/recipes/${id}/runs`) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    sent.push(body);
    return Response.json(body?.plan ? { plan: { kind: "run_all", ...plan } } : { run: { ...RUN, recipeId: id } });
  };
  return sent;
}

describe("the rows to run again", () => {
  it("draw one row per workflow the person may run, a shared one wearing its owner, none for a viewed project's, and read no run history for them", async () => {
    answers.maps = [map("m1", { changed: at(5) })];
    answers.workflows = { recipes: [
      wf("w1", { again: 2, changed: at(2) }),
      wf("w2", { owner: BO, project: "p-edit", again: 1, changed: at(2) }),
      wf("w3", { owner: BO, project: "p-view", again: 1, changed: at(2) }),
      wf("w4", { changed: at(2) }),
    ] };
    answers.projects = [project("p-edit", "editor"), project("p-view", "viewer")];
    await open();
    expect(container.querySelectorAll("[data-attention]").map((r) => r.getAttribute("data-attention"))).toEqual(["w1", "w2"]);
    expect(row("w1")!.querySelector("span")!.textContent).toBe("Flow w1 has 2 nodes to run again.");
    expect(row("w1")!.querySelector("[data-owner-pill]")).toBeNull();
    expect(row("w2")!.querySelector("[data-owner-pill]")?.getAttribute("aria-label")).toBe("Shared by Bo Brandt");
    expect(runButton("w1")?.getAttribute("aria-label")).toBe("Run Flow w1");
    expect(runButton("w2")?.getAttribute("aria-label")).toBe("Run Flow w2");
    // The rows' runners are quiet and the lead is a map: no history read.
    expect(runsReads()).toEqual([]);
  });

  it("open the canvas's confirmation from Run on a wide plan, and a closed confirmation starts nothing", async () => {
    answers.workflows = { recipes: [wf("w1", { again: 2 })] };
    const sent = runsOf("w1", { wide: true, members: ["a", "b"] });
    await open();
    await press(runButton("w1")!);
    const dialog = host.document.body.querySelector("[data-run-confirm]")!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-label")).toBe("Run all");
    await press(dialog.querySelector("[data-cancel-run]")!);
    expect(host.document.body.querySelector("[data-run-confirm]")).toBeNull();
    expect(sent).toEqual([{ plan: true }]);
  });

  it("re-read the three lists once per notification after a run, and the leading workflow's history with them", async () => {
    answers.workflows = { recipes: [wf("w1", { again: 2, changed: at(3) })] };
    answers["run:r1"] = { run: SETTLED };
    const sent = runsOf("w1");
    await open();
    expect(calls("/api/maps")).toHaveLength(1);
    expect(runsReads()).toHaveLength(1);
    await press(runButton("w1")!);
    expect(sent).toEqual([{ plan: true }, { members: ["a"] }]);
    // Adopting the run asks once; its settlement asks both ports at once,
    // and both share one re-read: three reads of each list in all.
    expect([calls("/api/maps").length, calls("/api/recipes?origin=workflow").length, calls("/api/tables").length]).toEqual([3, 3, 3]);
    expect(calls("/api/projects")).toHaveLength(1);
    expect(calls("/api/templates")).toHaveLength(1);
    // The lead's history at the start, after each re-read, and the
    // runner's own read once the run settled.
    expect(runsReads()).toHaveLength(4);
  });

  it("show the settlement, never an answer to a re-read begun before it, even one that lands last", async () => {
    const before = { recipes: [wf("w1", { again: 2, changed: at(3) })] };
    const after = { recipes: [wf("w1", { changed: at(3) })] };
    const early = { maps: held(), workflows: held(), tables: held(), runs: held() };
    answers.workflows = inTurn(before, early.workflows.answer, after);
    answers.maps = inTurn([], early.maps.answer, []);
    answers.tables = inTurn([], early.tables.answer, [table("t1", { imported: at(9) })]);
    answers["runs:w1"] = inTurn({ runs: [] }, early.runs.answer, { runs: [{ startedAt: at(9) }] });
    const poll = held();
    answers["run:r1"] = poll.answer;
    runsOf("w1");
    await open();
    expect(leadPlace().textContent).toContain("Never run");
    await press(runButton("w1")!);
    // Adopting the run began a re-read, still in flight.
    expect(calls("/api/recipes?origin=workflow")).toHaveLength(2);
    // The run settles: a re-read begun after it answers at once.
    poll.release({ run: SETTLED });
    await settle();
    // The earlier re-read's answers, from before the settlement, land last.
    early.workflows.release(before);
    early.maps.release([]);
    early.tables.release([]);
    early.runs.release({ runs: [] });
    await settle();
    expect(row("w1")).toBeNull();
    expect(recentNames()).toEqual(["table_t1"]);
    expect(leadPlace().textContent).not.toContain("Never run");
    expect(leadPlace().textContent).toContain("ran ");
    // One re-read after adopting the run, one after its settlement.
    expect(calls("/api/recipes?origin=workflow")).toHaveLength(3);
  });

  it("withhold Run on a shared row while the projects are read, then say their failure there, and Try again gives the editor's Run and takes the viewer's row away", async () => {
    answers.workflows = { recipes: [
      wf("w1", { again: 1, changed: at(2) }),
      wf("w2", { owner: BO, project: "p-edit", again: 1, changed: at(2) }),
      wf("w3", { owner: BO, project: "p-view", again: 1, changed: at(2) }),
    ] };
    const projects = held();
    answers.projects = projects.answer;
    await open();
    expect(runButton("w1")?.getAttribute("aria-label")).toBe("Run Flow w1");
    for (const id of ["w2", "w3"]) {
      expect(runButton(id)).toBeNull();
      expect(row(id)!.querySelector('[role="status"]')?.textContent).toBe("Reading your projects…");
      expect(row(id)!.querySelector("[data-owner-pill]")?.getAttribute("aria-label")).toBe("Shared by Bo Brandt");
    }
    // Failed: the read's note with Try again in each withheld Run's place,
    // still no Run; their own row keeps its Run throughout.
    projects.fail("The projects couldn't be read.");
    await settle();
    for (const id of ["w2", "w3"]) {
      expect(runButton(id)).toBeNull();
      expect(row(id)!.textContent).toContain("The projects couldn't be read.");
      expect(row(id)!.querySelectorAll("button").map((b) => b.textContent)).toEqual(["Try again"]);
    }
    expect(runButton("w1")?.getAttribute("aria-label")).toBe("Run Flow w1");
    answers.projects = [project("p-edit", "editor"), project("p-view", "viewer")];
    await press(row("w3")!.querySelectorAll("button").find((b) => b.textContent === "Try again")!);
    expect(calls("/api/projects")).toHaveLength(2);
    expect(runButton("w2")?.getAttribute("aria-label")).toBe("Run Flow w2");
    expect(row("w3")).toBeNull();
    expect(runButton("w1")?.getAttribute("aria-label")).toBe("Run Flow w1");
  });

  it("say the projects read's failure once: at Recent's head while Recent stands, the rows' notes silent", async () => {
    answers.maps = [map("m1", { changed: at(5) }), map("m2", { project: "p-edit", changed: at(4) })];
    answers.workflows = { recipes: [
      wf("w2", { owner: BO, project: "p-edit", again: 1, changed: at(2) }),
      wf("w3", { owner: BO, project: "p-view", again: 1, changed: at(2) }),
    ] };
    answers.projects = failing("The projects couldn't be read.");
    await open();
    expect(alerts()).toEqual(["The projects couldn't be read."]);
    expect(container.querySelector("[data-recent]")!.querySelector('[role="alert"]')).not.toBeNull();
    expect(row("w2")!.textContent).toContain("The projects couldn't be read.");
    expect(row("w3")!.textContent).toContain("The projects couldn't be read.");
  });

  it("say it on the first withheld row when no Recent stands to carry it", async () => {
    // Ada's one item is Bo's workflow she changed last: it leads, so Recent
    // has nothing left to list.
    answers.workflows = { recipes: [wf("w2", { owner: BO, by: ADA, project: "p-edit", again: 1, changed: at(2) })] };
    answers.projects = failing("The projects couldn't be read.");
    await open();
    expect(leadKind()).toBe("continue");
    expect(container.querySelector("[data-recent]")).toBeNull();
    expect(alerts()).toEqual(["The projects couldn't be read."]);
    expect(row("w2")!.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("Recent", () => {
  /** Ten items across the three kinds, a day apart, newest first: the map
   * m10 on day 20 (Ada's own last change, so it leads) down to t1 on day
   * 11. Recent lists the eight after the lead, newest first. */
  function tenItems() {
    answers.maps = [map("m10", { changed: at(20) }), map("m7", { owner: BO, changed: at(17) }), map("m4", { changed: at(14), project: "p1" })];
    answers.workflows = { recipes: [wf("w9", { owner: BO, changed: at(19) }), wf("w6", { changed: at(16) }), wf("w3", { changed: at(13) })] };
    answers.tables = [
      table("t8", { imported: at(18) }), table("t5", { imported: at(15), projects: ["p1", "p2"] }),
      table("t2", { imported: at(12) }), table("t1", { imported: at(11) }),
    ];
    answers.projects = [project("p1", "owner"), project("p2", "editor")];
  }

  it("lists eight rows newest first under the instance's name, the lead left out, each the link to its item", async () => {
    instance.name = "Stadtwerke";
    tenItems();
    await open();
    expect(leadKind()).toBe("continue");
    const heading = container.querySelector("[data-recent]")!.querySelector("h2");
    expect(heading?.textContent).toBe("Recent in Stadtwerke");
    expect(recentNames()).toEqual([
      "Flow w9, Bo Brandt", "table_t8", "Map m7, Bo Brandt", "Flow w6", "table_t5", "Map m4", "Flow w3", "table_t2",
    ]);
    expect(recentRows().map((r) => r.getAttribute("role"))).toEqual(Array(8).fill("link"));
    // No Add or Move on Home: a project is a label on the row.
    expect(container.querySelector("[data-recent]")!.querySelectorAll("button")).toHaveLength(0);
    expect(metaOf("table_t5")!.querySelector("[data-recent-where]")?.textContent).toBe("in Project p1, Project p2");
    expect(metaOf("Map m4")!.querySelector("[data-recent-where]")?.textContent).toBe("in Project p1");
    expect(metaOf("Flow w6")!.querySelector("[data-recent-where]")?.textContent).toBe("not in a project");
    await press(recentRows()[0]);
    expect(nav.push).toHaveBeenLastCalledWith("/workflows/w9");
    await act(async () => {
      recentRows()[2].dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true }), { key: "Enter" }));
    });
    expect(nav.push).toHaveBeenLastCalledWith("/maps/m7");
  });

  it("is headed Recent when the instance has no name, and is absent with nothing to list", async () => {
    answers.maps = [map("m1", { changed: at(3) }), map("m2", { changed: at(2) })];
    await open();
    expect(container.querySelector("[data-recent]")!.querySelector("h2")?.textContent).toBe("Recent");
    expect(recentNames()).toEqual(["Map m2"]);
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    answers.maps = [map("m1")];
    await open();
    expect(container.querySelector("[data-recent]")).toBeNull();
    expect(headings()).not.toContain("Recent");
  });

  it("withholds a filed item's where line while the projects are read, says an unfiled one's, keeps owners, and after their failure puts the note with Try again at its head", async () => {
    tenItems();
    const projects = held();
    answers.projects = projects.answer;
    await open();
    expect(metaOf("Map m4")!.querySelector("[data-recent-where]")).toBeNull();
    expect(metaOf("Map m4")!.textContent).not.toContain("project");
    expect(metaOf("table_t5")!.querySelector("[data-recent-where]")).toBeNull();
    expect(metaOf("Flow w6")!.querySelector("[data-recent-where]")?.textContent).toBe("not in a project");
    expect(recentNames()).toContain("Map m7, Bo Brandt");
    projects.fail("The projects couldn't be read.");
    await settle();
    const head = container.querySelector("[data-recent-projects-failure]")!;
    expect(head.getAttribute("role")).toBe("alert");
    expect(head.textContent).toContain("The projects couldn't be read.");
    expect(metaOf("Map m4")!.querySelector("[data-recent-where]")).toBeNull();
    expect(recentNames()).toHaveLength(8);
    answers.projects = [project("p1", "owner")];
    await press(head.querySelectorAll("button").find((b) => b.textContent === "Try again")!);
    expect(container.querySelector("[data-recent-projects-failure]")).toBeNull();
    expect(metaOf("Map m4")!.querySelector("[data-recent-where]")?.textContent).toBe("in Project p1");
    // A project the person no longer reaches is said without a name.
    expect(metaOf("table_t5")!.querySelector("[data-recent-where]")?.textContent).toBe("in Project p1, a project you no longer reach");
  });

  it("says a kind that failed beside the kinds that answered, with Try again, announced where the lead does not already say it", async () => {
    answers.maps = [map("m1", { changed: at(5) }), map("m2", { changed: at(4) })];
    answers.tables = failing("The datasets couldn't be read.");
    await open();
    expect(recentNames()).toEqual(["Map m2"]);
    const note = container.querySelector('[data-recent-failure="tables"]')!;
    expect(note.getAttribute("role")).toBe("alert");
    answers.tables = [table("t1", { imported: at(3) })];
    await press(note.querySelectorAll("button").find((b) => b.textContent === "Try again")!);
    expect(recentNames()).toEqual(["Map m2", "table_t1"]);
    expect(container.querySelector("[data-recent-failure]")).toBeNull();
  });

  it("leaves the announcing to the lead's note when the workflows failed", async () => {
    answers.maps = [map("m1", { changed: at(5) })];
    answers.workflows = failing("The workflows couldn't be read.");
    await open();
    expect(leadKind()).toBe("failed");
    expect(recentNames()).toEqual(["Map m1"]);
    expect(container.querySelector('[data-recent-failure="workflows"]')?.getAttribute("role")).toBeNull();
    expect(alerts()).toEqual(["The workflows couldn't be read."]);
  });
});

describe("the leading workflow's run history", () => {
  it("shows the glyph with its title when the history cannot be read, and Try again under the card restores the time", async () => {
    answers.workflows = { recipes: [wf("w1", { changed: at(3) })] };
    answers["runs:w1"] = failing("No.");
    await open();
    expect(leadKind()).toBe("continue");
    expect(leadPlace().textContent).not.toContain("Never run");
    const chip = leadPlace().querySelectorAll("span").find((span) => span.textContent === "—")!;
    expect(chip.getAttribute("title")).toBe("The run history couldn't be read");
    const note = leadPlace().querySelector("[data-lead-history-failure]")!;
    expect(note.textContent).toContain("The run history couldn't be read.");
    answers["runs:w1"] = { runs: [{ startedAt: at(9) }] };
    await press(note.querySelectorAll("button").find((b) => b.textContent === "Try again")!);
    expect(runsReads()).toHaveLength(2);
    expect(leadPlace().querySelector("[data-lead-history-failure]")).toBeNull();
    expect(leadPlace().textContent).toContain("ran ");
  });
});

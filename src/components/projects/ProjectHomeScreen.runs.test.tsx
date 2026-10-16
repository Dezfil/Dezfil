import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOverview, TableListing } from "../api";
import { SignedIn } from "../sharing/signed-in";
import type { PersonLabel } from "../sharing/people";
import { installDomHost, type HostElement } from "../testing/dom-host";
import type { WorkflowListing } from "../workflow-model";
import { ProjectHomeScreen } from "./ProjectHomeScreen";

/**
 * The project home's runs, over its real reads answering through fetch:
 * a run started from a row to run again is followed until it settles,
 * even after the re-read that finds it under way takes the row away, so
 * its settlement still reads the project again.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/p1" }));
vi.mock("@/components/theme", () => ({ useTheme: () => ({ theme: "light", toggle: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("../builder/drawer/use-operations", () => ({ useOperations: () => ({ operations: [] }) }));
vi.mock("../shell/use-project-name", () => ({ invalidateProjects: vi.fn() }));
vi.mock("../shell/ProjectCrumbTail", () => ({ ProjectCrumbTail: () => null }));
vi.mock("../shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("../sharing/MembersLine", () => ({ MembersLine: () => null }));
vi.mock("../sharing/use-project-people", async (original) => ({
  ...await original<typeof import("../sharing/use-project-people")>(),
  useProjectPeople: () => new Map(),
}));
vi.mock("../AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("../use-upload-queue", () => ({
  useUploadQueue: () => ({ entries: [], settled: true, projectId: null, dismiss: () => 0, reset: () => {}, current: () => ({ settled: true }) }),
}));

const ADA: PersonLabel = { name: "Ada Lovelace", sqlName: "ada" };
const at = (d: number) => `2026-10-${String(d).padStart(2, "0")}T09:00:00.000Z`;

function wf(id: string, f: { again?: number; status?: string } = {}): WorkflowListing {
  const again = f.again ?? 0;
  return JSON.parse(JSON.stringify({
    id, name: `Flow ${id}`, origin: "workflow", projectId: "p1", owner: ADA, home: ADA.sqlName,
    createdAt: at(1), updatedAt: at(3), editRevision: `rev-${id}`, lastChangedAt: at(3), lastChangedBy: ADA,
    summary: { nodes: 3, sources: 1, liveOutputs: 1, status: f.status ?? (again > 0 ? "run_again" : "up_to_date"), count: f.status ? 1 : again },
    steps: [],
  })) as WorkflowListing;
}

function table(id: string): TableListing {
  return JSON.parse(JSON.stringify({
    id, name: `table_${id}`, qualifiedName: `table_${id}`, projectIds: ["p1"], owner: ADA,
    rowCount: 10, geometryColumn: null, geometryType: null, sizeBytes: 100,
    createdAt: at(9), importedAt: at(9),
  })) as TableListing;
}

const RECORD = { id: "p1", name: "Field tests", note: null, role: "owner", owner: ADA, createdAt: at(1), updatedAt: at(1) };

type Answer = unknown | (() => Promise<Response>);
let answers: Record<string, Answer>;
let fetchSpy: ReturnType<typeof vi.fn>;
let posts: (url: string, init: RequestInit) => Promise<Response>;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

const LISTS: Record<string, string> = {
  "/api/projects/p1": "record",
  "/api/maps?project=p1": "maps",
  "/api/recipes?origin=workflow&project=p1": "workflows",
  "/api/tables?project=p1": "tables",
  "/api/projects": "projects",
};

const answer = (value: Answer) =>
  typeof value === "function" ? (value as () => Promise<Response>)() : Response.json(value);

beforeEach(() => {
  answers = {
    record: RECORD,
    maps: [] as MapOverview[],
    workflows: { recipes: [] as WorkflowListing[] },
    tables: [] as TableListing[],
    projects: [{ id: "p1", name: "Field tests" }],
  };
  posts = async () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return posts(url, init);
    const run = /^\/api\/recipes\/([^/]+)\/runs\/([^/]+)$/.exec(url);
    if (run) return answer(answers[`run:${run[2]}`]);
    const runs = /^\/api\/recipes\/([^/]+)\/runs$/.exec(url);
    if (runs) return answer(answers[`runs:${runs[1]}`] ?? { runs: [] });
    const key = LISTS[url];
    if (!key) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    return answer(answers[key]);
  });
  vi.stubGlobal("fetch", fetchSpy);
  host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
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
async function open() {
  await act(async () => root.render(<SignedIn account={ADA}><ProjectHomeScreen id="p1" files /></SignedIn>));
  await settle();
}
async function press(element: HostElement) {
  await act(async () => { element.click(); });
  await settle();
}
function held() {
  let release!: (response: Response) => void;
  return {
    answer: () => new Promise<Response>((resolve) => { release = resolve; }),
    release: (body: unknown) => release(Response.json(body)),
  };
}
function inTurn(...steps: unknown[]) {
  let n = 0;
  return () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    return Promise.resolve(Response.json(step));
  };
}
const calls = (url: string) =>
  fetchSpy.mock.calls.filter(([u, init]) => String(u) === url && ((init as RequestInit | undefined)?.method ?? "GET") === "GET");
const row = (id: string) => container.querySelector(`[data-attention="${id}"]`);
const runButton = (id: string) => row(id)?.querySelectorAll("button").find((b) => b.getAttribute("aria-label")?.startsWith("Run ")) ?? null;

const RUN = { id: "r1", recipeId: "w1", kind: "single", outcome: null, cancelled: false, startedAt: at(9), finishedAt: null, members: [] };
const SETTLED = { ...RUN, outcome: "succeeded", finishedAt: at(9) };
function runsOf(id: string) {
  const sent: unknown[] = [];
  posts = async (url, init) => {
    const body = JSON.parse(String(init.body ?? "null")) as { plan?: boolean } | null;
    if (url !== `/api/recipes/${id}/runs`) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    sent.push(body);
    return Response.json(body?.plan ? { plan: { kind: "run_all", wide: false, members: ["a"] } } : { run: { ...RUN, recipeId: id } });
  };
  return sent;
}

describe("the project home's rows to run again", () => {
  it("follow a run started here after its row leaves for the run in progress, and read the project again once it settles", async () => {
    const before = { recipes: [wf("w1", { again: 2 })] };
    // The read after the start finds the run under way: no longer one to
    // run again, so the row leaves.
    const during = { recipes: [wf("w1", { status: "in_progress" })] };
    const after = { recipes: [wf("w1")] };
    answers.workflows = inTurn(before, during, after);
    answers.tables = inTurn([], [], [table("t1")]);
    const poll = held();
    answers["run:r1"] = poll.answer;
    const sent = runsOf("w1");
    await open();
    expect(runButton("w1")).not.toBeNull();
    await press(runButton("w1")!);
    expect(sent).toEqual([{ plan: true }, { members: ["a"] }]);
    // Adopting the run read the project again: the run is under way, the row gone.
    expect(calls("/api/recipes?origin=workflow&project=p1")).toHaveLength(2);
    expect(row("w1")).toBeNull();
    expect(container.textContent).not.toContain("table_t1");
    // The run settles: the home reads the project again, and the dataset
    // the run made is drawn.
    poll.release({ run: SETTLED });
    await settle();
    expect(calls("/api/recipes?origin=workflow&project=p1").length).toBeGreaterThan(2);
    expect(calls("/api/tables?project=p1").length).toBeGreaterThan(2);
    expect(container.textContent).toContain("table_t1");
    // Settled and read again after it: the followed run is let go.
    expect(container.querySelector("[data-attention-area]")).toBeNull();
  });
});

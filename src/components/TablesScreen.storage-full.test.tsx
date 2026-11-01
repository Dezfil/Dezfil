import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignedIn } from "./sharing/signed-in";
import { installDomHost, type HostElement } from "./testing/dom-host";

/**
 * The Data page says so while the instance's storage is full, from the
 * runtime read, and stops saying so when what the page knows has moved and
 * the read has space again: a deleted dataset is how a person frees it.
 */

const page = vi.hoisted(() => ({ world: { projects: [], all: [] as unknown[], scoped: [] as unknown[] } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/data" }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "updated", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: page.world }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./scope/ScopeFilter", () => ({ ScopeFilter: () => null }));
vi.mock("./use-async-collection", () => ({
  useAsyncCollection: () => ({ state: { status: "ready", value: [] }, retry: vi.fn(), mutate: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-grid-columns", () => ({ useGridColumns: () => null }));
vi.mock("./use-upload-queue", () => ({
  useUploadQueue: () => ({ entries: [], add: vi.fn(), dismiss: () => 0, current: () => ({ settled: true }), reset: vi.fn() }),
}));
vi.mock("./AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./projects/AddToProjectDialog", () => ({ AddToProjectDialog: () => null }));
vi.mock("./AddToMapDialog", async (original) => ({ ...(await original<typeof import("./AddToMapDialog")>()), AddToMapDialog: () => null }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const MB = 1024 * 1024;
let storage: { full: boolean; free: number; total: number; threshold: number };
let reads: number;
let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  page.world = { projects: [], all: [], scoped: [] };
  reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") { reads += 1; return Response.json({ storage }); }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
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

async function draw() {
  const { TablesScreen } = await import("./TablesScreen");
  await act(async () => {
    root.render(<SignedIn account={{ name: "Ada Okafor", sqlName: "ada" }}><TablesScreen /></SignedIn>);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const line = () => container.querySelectorAll("p").map(element => element.textContent).filter(words => words.startsWith("Storage is full"));

it("shows the one line while full, under the heading and before the list's tools", async () => {
  storage = { full: true, free: 412 * MB, total: 20480 * MB, threshold: 512 * MB };
  await draw();
  expect(line()).toEqual(["Storage is full: 412 MB free."]);
  const seen = container.textContent;
  expect(seen.indexOf("Add data")).toBeLessThan(seen.indexOf("Storage is full"));
});

it("shows nothing while there is space", async () => {
  storage = { full: false, free: 4096 * MB, total: 20480 * MB, threshold: 512 * MB };
  await draw();
  expect(reads).toBeGreaterThan(0);
  expect(line()).toEqual([]);
});

it("reads again when the list moves, so the line goes once a deletion has made space", async () => {
  storage = { full: true, free: 100 * MB, total: 20480 * MB, threshold: 512 * MB };
  page.world = { projects: [], all: [{ id: "1", projectIds: [] }], scoped: [] };
  await draw();
  expect(line()).toEqual(["Storage is full: 100 MB free."]);
  storage = { full: false, free: 4096 * MB, total: 20480 * MB, threshold: 512 * MB };
  page.world = { projects: [], all: [], scoped: [] };
  await draw();
  expect(line()).toEqual([]);
});

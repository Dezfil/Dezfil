import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDomHost, type HostElement } from "./testing/dom-host";
import { SignedIn } from "./sharing/signed-in";
import type { SettleReport } from "./upload-queue";

/**
 * The Data page says how a file batch settled outside a closed Add data
 * dialog, in the look of its outcome. The queue is a stand-in that hands
 * the page its settlement; the words and tones expected are written here.
 */

const queue = vi.hoisted(() => ({ onSettled: null as null | ((report: SettleReport) => void) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/data" }));
vi.mock("./use-view-prefs", async (original) => ({
  ...(await original<typeof import("./use-view-prefs")>()),
  useViewPrefs: () => ({ view: "grid", sort: "updated", settled: true, setView: vi.fn(), setSort: vi.fn() }),
}));
vi.mock("./scope/use-scope", () => ({ useProjectScope: () => ({ scope: { kind: "all" }, setScope: vi.fn() }) }));
vi.mock("./scope/use-scope-world", () => ({
  useScopeWorld: () => ({ state: { status: "ready", value: { projects: [], all: [], scoped: [] } }, retry: vi.fn(), mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./scope/ScopeFilter", () => ({ ScopeFilter: () => null }));
vi.mock("./use-async-collection", () => ({
  useAsyncCollection: () => ({ state: { status: "ready", value: [] }, retry: vi.fn(), mutate: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-grid-columns", () => ({ useGridColumns: () => null }));
vi.mock("./use-upload-queue", () => ({
  useUploadQueue: (options: { onSettled: (report: SettleReport) => void }) => {
    queue.onSettled = options.onSettled;
    return { entries: [], add: vi.fn(), dismiss: () => 0, current: () => ({ settled: true }), reset: vi.fn() };
  },
}));
vi.mock("./AddDataDialog", () => ({ AddDataDialog: () => null }));
vi.mock("./projects/AddToProjectDialog", () => ({ AddToProjectDialog: () => null }));
vi.mock("./AddToMapDialog", async (original) => ({ ...(await original<typeof import("./AddToMapDialog")>()), AddToMapDialog: () => null }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

let host: ReturnType<typeof installDomHost>;
let container: HostElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  host = installDomHost();
  // A success notice clears itself on the window's timer.
  Object.assign(host.window, { setTimeout, clearTimeout });
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  const { TablesScreen } = await import("./TablesScreen");
  await act(async () => {
    root.render(<SignedIn account={{ name: "Ada Okafor", sqlName: "ada" }}><TablesScreen /></SignedIn>);
    await new Promise((r) => setTimeout(r, 0));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
});

const report = (over: Partial<SettleReport>): SettleReport => ({
  files: 1, imported: 0, failed: 0, unconfirmed: 0, notStarted: 0, entries: [], tables: [], skips: [], dismissed: false, batch: 1, ...over,
});
const settleBatch = (over: Partial<SettleReport>) => act(async () => queue.onSettled!(report(over)));
/** The notice's look: the success notice, or the failure note in its tone. */
const shown = () => [
  ...container.querySelectorAll('[role="status"]').map((n) => ["success", n.textContent]),
  ...container.querySelectorAll('[role="alert"]').map((n) => [n.getAttribute("data-tone"), n.querySelector("p")?.textContent]),
];

it("says a settled upload in the look of its outcome: all done as a success, all failed as a failure, some of each as a warning", async () => {
  expect(shown()).toEqual([]);
  await settleBatch({ failed: 1, entries: [{ id: 1, name: "roads.csv", state: "failed", progress: 1, error: "The file is empty." }] });
  expect(shown()).toEqual([["danger", "roads.csv could not be imported: The file is empty"]]);
  await settleBatch({
    files: 2, imported: 1, failed: 1, tables: [{ name: "wells" } as SettleReport["tables"][number]],
    entries: [{ id: 1, name: "wells.csv", state: "imported", progress: 1, error: null }, { id: 2, name: "roads.csv", state: "failed", progress: 1, error: "The file is empty." }],
  });
  expect(shown()).toEqual([["warn", "1 table ready. · roads.csv could not be imported: The file is empty"]]);
  await settleBatch({ imported: 1, tables: [{ name: "wells" } as SettleReport["tables"][number]], entries: [{ id: 1, name: "wells.csv", state: "imported", progress: 1, error: null }] });
  expect(shown()).toEqual([["success", "wells is ready."]]);
});

it("keeps a failed batch's note until it is dismissed, while a success clears itself", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    Object.assign(host.window, { setTimeout, clearTimeout });
    await settleBatch({ failed: 1, entries: [{ id: 1, name: "roads.csv", state: "failed", progress: 1, error: "The file is empty." }] });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(shown()).toEqual([["danger", "roads.csv could not be imported: The file is empty"]]);
    await act(async () => container.querySelector('[role="alert"]')!.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Dismiss")!.click());
    expect(shown()).toEqual([]);
    await settleBatch({ imported: 1, tables: [{ name: "wells" } as SettleReport["tables"][number]], entries: [{ id: 1, name: "wells.csv", state: "imported", progress: 1, error: null }] });
    expect(shown()).toEqual([["success", "wells is ready."]]);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(shown()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

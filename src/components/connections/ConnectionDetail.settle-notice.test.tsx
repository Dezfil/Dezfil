import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PgConnection } from "@/lib/metadata/connections";
import type { SettleReport } from "@/components/upload-queue";
import { installDomHost, type HostElement } from "../testing/dom-host";

/**
 * The connection page says how a file batch settled outside a closed Add
 * data dialog, in the look of its outcome: its own quiet line for a batch
 * that landed whole, the failure note for one that failed, its warning
 * tone for one between. The queue is a stand-in that hands the page its
 * settlement; every read is a fake.
 */

const queue = vi.hoisted(() => ({ onSettled: null as null | ((report: SettleReport) => void) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/connections/c1" }));
vi.mock("@/components/use-upload-queue", () => ({
  useUploadQueue: (options: { onSettled: (report: SettleReport) => void }) => {
    queue.onSettled = options.onSettled;
    return { entries: [], add: vi.fn(), dismiss: () => 0, current: () => ({ settled: true }), reset: vi.fn() };
  },
}));
vi.mock("@/components/AddDataDialog", () => ({ AddDataDialog: () => null }));

const saved: PgConnection = {
  id: "c1", name: "City", host: "db.example.test", port: 5432, database: "gis", username: "reader", ssl: true,
  createdAt: "2026-09-01T00:00:00.000Z", status: "connected", lastCheckedAt: "2026-10-01T00:00:00.000Z",
  lastCheckError: null, serverVersion: "PostgreSQL 16.4", postgisVersion: "3.4.3",
};

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
beforeEach(async () => {
  host = installDomHost();
  Object.assign(host.window, { setTimeout, clearTimeout });
  vi.stubGlobal("self", { setTimeout, clearTimeout });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") return Response.json({ rules: { "connections.create": "everyone" } });
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: false } });
    if (url === "/api/connections/postgis") return Response.json([saved]);
    if (url === "/api/connections/postgis/c1/snapshots") return Response.json({ snapshots: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  container = host.document.body.appendChild(host.document.createElement("div"));
  root = createRoot(container as unknown as Element);
  const { ConnectionDetail } = await import("./ConnectionDetail");
  await act(async () => root.render(<ConnectionDetail id="c1" />));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.document.body.removeChild(container);
  vi.unstubAllGlobals();
  host.uninstall();
});

const report = (over: Partial<SettleReport>): SettleReport => ({
  files: 1, imported: 0, failed: 0, unconfirmed: 0, notStarted: 0, entries: [], tables: [], skips: [], dismissed: false, batch: 1, ...over,
});
const settleBatch = (over: Partial<SettleReport>) => act(async () => queue.onSettled!(report(over)));
const wells = { name: "wells" } as SettleReport["tables"][number];
/** The notice's look: the page's quiet line, or the failure note in its tone. */
const shown = () => [
  ...container.querySelectorAll('[role="status"]').map((n) => ["success", n.textContent]),
  ...container.querySelectorAll('[role="alert"]').map((n) => [n.getAttribute("data-tone"), n.querySelector("p")?.textContent]),
];

it("says a settled upload in the look of its outcome: all done as a success, all failed as a failure, some of each as a warning", async () => {
  expect(container.textContent).toContain("City");
  expect(shown()).toEqual([]);
  await settleBatch({ failed: 1, entries: [{ id: 1, name: "roads.csv", state: "failed", progress: 1, error: "The file is empty." }] });
  expect(shown()).toEqual([["danger", "roads.csv could not be imported: The file is empty"]]);
  await settleBatch({
    files: 2, imported: 1, failed: 1, tables: [wells],
    entries: [{ id: 1, name: "wells.csv", state: "imported", progress: 1, error: null }, { id: 2, name: "roads.csv", state: "failed", progress: 1, error: "The file is empty." }],
  });
  expect(shown()).toEqual([["warn", "1 table ready. · roads.csv could not be imported: The file is empty"]]);
  await settleBatch({ imported: 1, tables: [wells], entries: [{ id: 1, name: "wells.csv", state: "imported", progress: 1, error: null }] });
  expect(shown()).toEqual([["success", "wells is ready."]]);
});

it("lets a failed batch's note be dismissed", async () => {
  await settleBatch({ failed: 1, entries: [{ id: 1, name: "roads.csv", state: "failed", progress: 1, error: null }] });
  expect(shown()).toEqual([["danger", "roads.csv could not be imported"]]);
  await act(async () => container.querySelector('[role="alert"]')!.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === "Dismiss")!.click());
  expect(shown()).toEqual([]);
});

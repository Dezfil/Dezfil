import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TableInspection } from "./api";
import { installDomHost } from "./testing/dom-host";
import { TableDetailScreen } from "./TableDetailScreen";
import { useAsync } from "./ui/AsyncState";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/tables/roads" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("./ui/AsyncState", async (original) => ({ ...(await original<typeof import("./ui/AsyncState")>()), useAsync: vi.fn() }));
vi.mock("./builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));
vi.mock("./TablePreviewMap", () => ({ TablePreviewMap: () => null }));
vi.mock("./shell/PlainCrumbTail", () => ({ PlainCrumbTail: () => null }));

/**
 * The dataset page's trash button asks first, through the delete dialog,
 * and a delete there lands on the Data page as it always has.
 */
const table: TableInspection = {
  id: "t-roads", name: "roads", sourceFilename: null, file: "tables/t-roads.parquet", format: "csv", geometryColumn: "geometry", geometryType: "POINT",
  crsAssumed: false, headerSuspect: false, rowCount: 3, source: "url", sourceParams: { url: "https://example.test/roads.csv" },
  createdAt: "2026-10-01T10:00:00Z", importedAt: "2026-10-01T10:00:00Z", columns: [], preview: [], sizeBytes: 1024, projectIds: [], inputs: null,
  owner: { name: "Bo", sqlName: "bo" }, qualifiedName: "roads",
};

let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>;
let calls: string[];
beforeEach(() => {
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  calls = []; push.mockClear();
  vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: table }, retry: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/tables/t-roads/readers") return Response.json({ table: { id: "t-roads", name: "roads", rowCount: 3 }, readers: [], unlisted: 0 });
    if (url === "/api/tables/t-roads" && init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({});
  }));
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

const byLabel = (label: string) => host.document.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement;
const button = (text: string) => host.document.querySelectorAll("button").find((b) => b.textContent === text)!;
const dialog = () => host.document.querySelector('[role="dialog"]');

it("opens the dialog from the trash button, deletes nothing until asked, and lands on the Data page after a delete", async () => {
  await act(async () => root.render(<TableDetailScreen name="roads" />));
  expect(dialog()).toBeNull();
  await act(async () => { byLabel("Delete roads").click(); });
  expect(dialog()?.textContent).toContain("Delete roads?");
  expect(dialog()?.textContent).toContain("This deletes the table and its 3 rows. No map layer or workflow step reads from it.");
  expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);

  await act(async () => { button("Cancel").click(); });
  expect(dialog()).toBeNull();
  expect(push).not.toHaveBeenCalled();

  await act(async () => { byLabel("Delete roads").click(); });
  await act(async () => { button("Delete table").click(); });
  expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual(["DELETE /api/tables/t-roads"]);
  expect(push).toHaveBeenCalledExactlyOnceWith("/data");
});

it("keeps the table it was opened for when a reread brings a same-named replacement", async () => {
  await act(async () => root.render(<TableDetailScreen name="roads" />));
  await act(async () => { byLabel("Delete roads").click(); });
  expect(dialog()?.textContent).toContain("This deletes the table and its 3 rows.");
  // A refresh rereads the page while the dialog is open, and the name now
  // holds a replacement with its own identifier.
  vi.mocked(useAsync).mockReturnValue({ state: { status: "ready", value: { ...table, id: "t-roads-2", rowCount: 7 } }, retry: vi.fn() });
  await act(async () => root.render(<TableDetailScreen name="roads" />));
  expect(dialog()?.textContent).toContain("This deletes the table and its 3 rows.");
  await act(async () => { button("Delete table").click(); });
  expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual(["DELETE /api/tables/t-roads"]);
  expect(calls.some((call) => call.includes("t-roads-2"))).toBe(false);
});

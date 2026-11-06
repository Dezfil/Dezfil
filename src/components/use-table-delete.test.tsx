import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TableListing } from "./api";
import { TableActions } from "./data-cards";
import { ListHeading } from "./ListHeading";
import { installDomHost } from "./testing/dom-host";
import { useTableDelete } from "./use-table-delete";

/**
 * The Data page's table delete, on a stand-in list drawn with the page's
 * own actions: each trash button asks about its own table, and once a
 * delete has removed the item, focus moves to the next item's delete,
 * else the previous one's, else the list's heading.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>;
let calls: string[];
beforeEach(() => {
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const readers = /^\/api\/tables\/([^/]+)\/readers$/.exec(url);
    if (readers) return Response.json({ table: { id: readers[1], name: readers[1].slice(2), rowCount: 2 }, readers: [], unlisted: 0 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

const listing = (name: string) => ({
  id: `t-${name}`, name, qualifiedName: name, rowCount: 2, geometryColumn: null, geometryType: null, projectIds: [],
  source: "upload", sourceFilename: `${name}.csv`, format: "csv", crsAssumed: false, headerSuspect: false,
  createdAt: "2026-09-01T00:00:00Z", importedAt: null, sizeBytes: 10,
}) as unknown as TableListing;
const noop = () => {};

function List({ names }: { names: string[] }) {
  const [items, setItems] = useState(names);
  const { ask, dialog } = useTableDelete((table) => setItems((all) => all.filter((name) => name !== table.name)));
  return (
    <>
      <ListHeading title="Data" line={null} />
      {items.map((name) => (
        <article key={name}>
          <TableActions table={listing(name)} rowStyle="" onOpen={noop} onQuery={noop} onAddToMap={noop} onFile={noop}
            onDelete={(opener) => ask(listing(name), opener)} />
        </article>
      ))}
      {dialog}
    </>
  );
}

const byLabel = (label: string) => host.document.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement | null;
const button = (text: string) => host.document.querySelectorAll("button").find((b) => b.textContent === text)!;
const active = () => host.document.activeElement as unknown as HTMLElement | null;
async function remove(name: string) {
  // A pointer press: nothing focuses the button first.
  await act(async () => { byLabel(`Delete ${name}`)!.click(); });
  expect(host.document.querySelector('[role="dialog"]')?.textContent).toContain(`Delete ${name}?`);
  await act(async () => { button("Delete table").click(); });
  expect(host.document.querySelector('[role="dialog"]')).toBeNull();
  expect(byLabel(`Delete ${name}`)).toBeNull();
}

it("asks about the table whose trash was pressed, and deletes nothing on Cancel", async () => {
  await act(async () => root.render(<List names={["alpha", "beta"]} />));
  byLabel("Delete beta")!.focus();
  await act(async () => { byLabel("Delete beta")!.click(); });
  expect(calls).toEqual(["GET /api/tables/t-beta/readers"]);
  await act(async () => { button("Cancel").click(); });
  expect(byLabel("Delete beta")).not.toBeNull();
  expect(active()).toBe(byLabel("Delete beta"));
  expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
});

it("moves focus to the next item's delete, then the previous one's, then the list's heading", async () => {
  await act(async () => root.render(<List names={["alpha", "beta", "gamma"]} />));
  await remove("beta");
  expect(calls).toContain("DELETE /api/tables/t-beta");
  expect(active()).toBe(byLabel("Delete gamma"));

  await remove("gamma");
  expect(active()).toBe(byLabel("Delete alpha"));

  await remove("alpha");
  const heading = host.document.querySelector("[data-list-heading]")!.querySelector("h1")!;
  expect(active()).toBe(heading);
  expect(heading.getAttribute("tabindex")).toBe("-1");
});

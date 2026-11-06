import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TableReaders } from "@/lib/table-readers";
import { HostEvent, installDomHost } from "./testing/dom-host";
import { DeleteTableDialog, type DeletableTable } from "./DeleteTableDialog";

/**
 * The delete dialog against answers written out by hand: what it says in
 * each state, word for word, and that it deletes the table it was opened
 * for, once, only when asked.
 */

type Pending = { url: string; method: string; signal?: AbortSignal; resolve: (response: Response) => void; reject: (error: unknown) => void };
let host: ReturnType<typeof installDomHost>, root: ReturnType<typeof createRoot>;
let requests: Pending[];
const deleted = vi.fn();

const roads: DeletableTable = { id: "t-roads", name: "roads", rowCount: 1200 };
const answer = (table: DeletableTable, readers: TableReaders["readers"], unlisted = 0): TableReaders => ({
  table: { id: table.id, name: table.name, rowCount: table.rowCount }, readers, unlisted,
});
const fixture = answer(roads, [
  { kind: "layer", map: { id: "m-a", name: "Alpha", published: true }, layer: { id: "l-1", name: "One" } },
  { kind: "layer", map: { id: "m-a", name: "Alpha", published: true }, layer: { id: "l-2", name: "Two" } },
  { kind: "layer", map: { id: "m-b", name: "Beta", published: false }, layer: { id: "l-3", name: "Hidden" } },
  { kind: "step", workflow: { id: "w-f", name: "Flow", }, step: { id: "s-1", position: 1, operation: "sql_step", label: "SQL step" } },
  { kind: "step", workflow: { id: "w-p", name: "Pending" }, step: { id: "s-2", position: 2, operation: "buffer", label: "Buffer" } },
], 1);

beforeEach(() => {
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  requests = []; deleted.mockClear();
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ url, method: init?.method ?? "GET", signal: init?.signal ?? undefined, resolve, reject });
  })));
});
afterEach(() => { act(() => root.unmount()); host.uninstall(); vi.unstubAllGlobals(); });

function Harness({ table }: { table: DeletableTable }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Opener</button>
    {open && <DeleteTableDialog table={table} onClose={() => setOpen(false)} onDeleted={deleted} />}
  </>;
}
const dialog = () => host.document.querySelector('[role="dialog"]');
const text = () => dialog()?.textContent ?? "";
const button = (label: string) => host.document.querySelectorAll("button").find((b) => b.textContent === label)!;
const click = (label: string) => act(async () => { button(label).click(); });
const settle = (request: Pending, response: Response) => act(async () => { request.resolve(response); });
const reads = () => requests.filter((r) => r.method === "GET");
const deletes = () => requests.filter((r) => r.method === "DELETE");
async function open(table: DeletableTable = roads) {
  await act(async () => root.render(<Harness table={table} />));
  button("Opener").focus();
  await click("Opener");
}
const escape = () => act(async () => {
  host.document.dispatchEvent(Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: "Escape" }));
});

it("checks by the table's identifier, says so while checking, and holds Delete table until it knows", async () => {
  await open();
  expect(reads().map((r) => r.url)).toEqual(["/api/tables/t-roads/readers"]);
  expect(text()).toContain("Delete roads?");
  expect(text()).toContain("This deletes the table and its 1,200 rows.");
  expect(host.document.querySelector('[role="status"]')?.textContent).toBe("Checking what reads it…");
  expect(button("Delete table").disabled).toBe(true);
  expect(button("Delete table").getAttribute("data-variant")).toBe("danger");
});

it("lists every reader it may name, counts the rest, and warns about the published map", async () => {
  await open();
  await settle(reads()[0], Response.json(fixture));
  expect(text()).toContain("This deletes the table and its 1,200 rows. These read from it and will stop working:");
  const rows = host.document.querySelector("[data-table-readers]")!.querySelectorAll("li").map((li) => li.textContent);
  expect(rows).toEqual([
    "AlphaLayer “One”Published",
    "AlphaLayer “Two”Published",
    "BetaLayer “Hidden”",
    "FlowStep 1 · SQL step",
    "PendingStep 2 · Buffer",
  ]);
  expect(text()).toContain("And 1 more in maps or workflows you can't open.");
  expect(text()).toContain("Published maps in this list can break for their readers.");
  expect(text()).not.toContain("No map layer or workflow step reads from it.");
  expect(host.document.querySelector('[role="status"]')).toBeNull();
  expect(button("Delete table").disabled).toBe(false);
});

it("shows the count alone when every reader is out of sight, and one sentence when nothing reads it", async () => {
  await open({ ...roads, rowCount: 1 });
  await settle(reads()[0], Response.json(answer({ ...roads, rowCount: 1 }, [], 2)));
  expect(text()).toContain("This deletes the table and its 1 row.");
  expect(text()).toContain("And 2 more in maps or workflows you can't open.");
  expect(host.document.querySelector("[data-table-readers]")).toBeNull();
  expect(text()).not.toContain("These read from it");
  expect(text()).not.toContain("Published maps");
  expect(text()).not.toContain("No map layer");
  await click("Cancel");

  await click("Opener");
  await settle(reads()[1], Response.json(answer({ ...roads, rowCount: 1 }, [])));
  expect(text()).toContain("This deletes the table and its 1 row. No map layer or workflow step reads from it.");
  expect(text()).not.toContain("more in maps");
  expect(text()).not.toContain("Published maps");
  expect(reads()).toHaveLength(2);
});

it("lets the owner decide when the check fails, refused or unreachable, and never shows a short list", async () => {
  await open();
  await settle(reads()[0], Response.json({ error: { code: "dependencies_unresolved", message: "A statement could not be analyzed." } }, { status: 422 }));
  expect(text()).toContain("Couldn't check what reads this table.");
  expect(text()).not.toContain("A statement could not be analyzed.");
  expect(host.document.querySelector("[data-table-readers]")).toBeNull();
  expect(text()).not.toContain("No map layer");
  expect(button("Delete table").disabled).toBe(false);
  await click("Cancel");

  await click("Opener");
  await act(async () => { reads()[1].reject(new TypeError("Failed to fetch")); });
  expect(text()).toContain("Couldn't check what reads this table.");
  expect(button("Delete table").disabled).toBe(false);
});

it("never fills a dialog with an answer for another table, and aborts the check it no longer needs", async () => {
  await open();
  const first = reads()[0];
  // The same mounted dialog, now asked about another table: the first
  // check is aborted, and its answer, arriving late, is dropped.
  const towns: DeletableTable = { id: "t-towns", name: "towns", rowCount: 4 };
  await act(async () => root.render(<Harness table={towns} />));
  expect(first.signal?.aborted).toBe(true);
  const second = reads()[1];
  expect(second.url).toBe("/api/tables/t-towns/readers");
  await settle(first, Response.json(fixture));
  expect(text()).toContain("Delete towns?");
  expect(text()).toContain("Checking what reads it…");
  expect(text()).not.toContain("Alpha");
  expect(button("Delete table").disabled).toBe(true);

  // An answer the server gives for some other table is no answer.
  await settle(second, Response.json(answer({ id: "t-other", name: "towns", rowCount: 4 }, [])));
  expect(text()).toContain("Couldn't check what reads this table.");
  expect(text()).not.toContain("No map layer");
  await click("Cancel");
  expect(second.signal?.aborted).toBe(true);
});

it("deletes the table it was opened for, by its identifier, once", async () => {
  await open();
  await settle(reads()[0], Response.json(fixture));
  await click("Delete table");
  await act(async () => { button("Delete table").click(); });
  expect(deletes().map((r) => r.url)).toEqual(["/api/tables/t-roads"]);
  expect(button("Delete table").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  await escape();
  expect(dialog()).not.toBeNull();
  await settle(deletes()[0], new Response(null, { status: 204 }));
  expect(deleted).toHaveBeenCalledOnce();
  expect(deletes()).toHaveLength(1);
});

it("keeps the dialog open with the error when the delete is refused or the server is unreachable", async () => {
  await open();
  await settle(reads()[0], Response.json(fixture));
  await click("Delete table");
  await settle(deletes()[0], Response.json({ error: { code: "not_found", message: "This table no longer exists." } }, { status: 404 }));
  expect(text()).toContain("This table no longer exists.");
  expect(deleted).not.toHaveBeenCalled();
  expect(button("Delete table").disabled).toBe(false);

  await click("Delete table");
  await act(async () => { deletes()[1].reject(new TypeError("Failed to fetch")); });
  expect(text()).toContain("Couldn't delete the table. Is the server reachable?");
  expect(deleted).not.toHaveBeenCalled();
  expect(dialog()).not.toBeNull();
});

it("deletes nothing on Cancel or Escape, checking or answered, and hands focus back", async () => {
  await open();
  await click("Cancel");
  expect(dialog()).toBeNull();
  expect(host.document.activeElement?.textContent).toBe("Opener");

  await click("Opener");
  await settle(reads()[1], Response.json(fixture));
  await escape();
  expect(dialog()).toBeNull();
  expect(host.document.activeElement?.textContent).toBe("Opener");
  expect(deletes()).toHaveLength(0);
  expect(deleted).not.toHaveBeenCalled();
});

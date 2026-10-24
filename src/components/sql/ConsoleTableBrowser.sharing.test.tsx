import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableListing } from "../api";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { SignedIn } from "../sharing/signed-in";
import { ConsoleTableBrowser } from "./ConsoleTableBrowser";
import { useSchemaInventory } from "./use-schema-inventory";

/**
 * The SQL console's source list as Bo, beside Ada's datasets reached through
 * Berlin housing study: grouped by person by default, at a switch on the
 * list grouped by project, the choice remembered for the account through its
 * settings; each row's name is what Bo types in SQL; the schema of each
 * dataset is read at the address its typed name gives, so Ada's `roads` is
 * never read as Bo's own.
 */

vi.mock("../builder/drawer/use-recipes", () => ({ useRecipes: () => ({ recipes: [], error: null, reload: vi.fn() }) }));

const ada = { name: "Ada Okafor", sqlName: "ada" };
const bo = { name: "Bo Lindqvist", sqlName: "bo" };
const table = (name: string, owner: typeof ada, projectIds: string[] = []): TableListing =>
  ({
    id: `${owner.sqlName}-${name}`, name, qualifiedName: owner === bo ? name : `${owner.sqlName}.${name}`, owner, projectIds,
    source: "upload", geometryColumn: "geom", geometryType: "LINESTRING", rowCount: 7,
  }) as unknown as TableListing;
const TABLES = [table("roads", bo), table("roads", ada, ["berlin"])];

let stored: string;
let calls: { url: string; method: string; body?: unknown }[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  stored = "person";
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: input, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (input === "/api/settings" && method === "GET") return ok({ sourceGrouping: stored });
    if (input === "/api/settings") return ok({});
    if (input === "/api/projects") return ok([{ id: "berlin", name: "Berlin housing study", updatedAt: "2026-09-01T00:00:00Z" }]);
    if (input.startsWith("/api/tables/")) {
      return ok({ columns: [{ name: input.includes("ada") ? "adas_column" : "bos_column", type: "VARCHAR" }], preview: [], geometryColumn: "geom", rowCount: 7 });
    }
    throw new Error(`unexpected ${method} ${input}`);
  }));
  host = installDomHost();
  const container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (selector: string) => host.document.querySelector(selector);
const all = (selector: string) => host.document.querySelectorAll(selector);
async function render(node: React.ReactNode) {
  await act(async () => root.render(<SignedIn account={bo}>{node}</SignedIn>));
  await settle();
  await settle();
}
const browser = (tables: TableListing[] = TABLES) => (
  <ConsoleTableBrowser tables={tables} columnsOf={() => null} progress={{ ready: 0, failed: 0, total: 0 }}
    selected="ada.roads" onActivate={() => {}} onOpenAsSql={() => {}} onInsertTable={() => {}} />
);
const groups = () => all("[data-table-group]").map((g) => ({
  head: g.querySelector("p")!.textContent,
  rows: g.querySelectorAll('[role="button"]').map((r) => r.getAttribute("aria-label")),
}));

describe("the console's source list", () => {
  it("groups by person by default: Yours, then Ada under her name and SQL name, her rows as typed", async () => {
    await render(browser());
    expect(groups()).toEqual([
      { head: "Yours", rows: ["roads"] },
      { head: "Ada Okafor· ada", rows: ["ada.roads"] },
    ]);
    const adas = q('[data-name="ada.roads"]')!;
    expect(adas.querySelector("i")?.textContent).toBe("ada.");
    expect(adas.getAttribute("data-hint")).toBe("In Berlin housing study");
    expect(adas.hasAttribute("data-selected")).toBe(true);
    expect(q('[data-name="roads"]')!.hasAttribute("data-selected")).toBe(false);
  });

  it("groups by project at the switch, each row with its owner's initials, and remembers it for the account", async () => {
    await render(browser());
    await act(async () => q('[aria-label="Group sources"]')!.querySelectorAll("button").find((b) => b.textContent === "By project")!.click());
    await settle();
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ url: "/api/settings", method: "PATCH", body: { sourceGrouping: "project" } });
    expect(groups()).toEqual([
      { head: "Berlin housing study", rows: ["ada.roads"] },
      { head: "Not in a project", rows: ["roads"] },
    ]);
    expect(q('[data-row-owner="ada"]')?.textContent).toBe("AO");
  });

  it("draws the owner's picture in a row by project by its version, and one's own initials where one has none", async () => {
    stored = "project";
    await render(browser([table("roads", bo), table("roads", { ...ada, pictureVersion: "a1" } as typeof ada, ["berlin"])]));
    const adas = q('[data-row-owner="ada"]')!.querySelector("[data-face]")!;
    expect(adas.querySelector("img")?.getAttribute("src")).toBe("/api/accounts/ada/picture?v=a1");
    expect(adas.textContent).toBe("AO");
    const own = q('[data-row-owner="bo"]')!.querySelector("[data-face]")!;
    expect(own.hasAttribute("data-me")).toBe(true);
    expect(own.textContent).toBe("BL");
    expect(own.querySelector("img")).toBeNull();
  });

  it("opens grouped by project when the account chose so", async () => {
    stored = "project";
    await render(browser());
    expect(groups().map((g) => g.head)).toEqual(["Berlin housing study", "Not in a project"]);
    expect((q('[aria-label="Group sources"]')!.querySelectorAll("button").find((b) => b.textContent === "By project") as HostElement).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the console's schema inventory", () => {
  it("reads each dataset at its typed name's address, and keys its columns by it", async () => {
    let columnsOf: ((name: string) => readonly string[] | null) | null = null;
    function Probe() {
      columnsOf = useSchemaInventory(TABLES).columnsOf;
      return null;
    }
    await render(<Probe />);
    await settle();
    expect(calls.map((c) => c.url).filter((u) => u.startsWith("/api/tables/")).sort()).toEqual(["/api/tables/ada.roads", "/api/tables/roads"]);
    expect(columnsOf!("ada.roads")).toEqual(["adas_column"]);
    expect(columnsOf!("roads")).toEqual(["bos_column"]);
  });
});

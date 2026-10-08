import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgConnection } from "@/lib/metadata/connections";
import { installDomHost, type HostElement } from "../testing/dom-host";
import { ConnectionsLedger } from "./ConnectionsLedger";
import { NewConnectionScreen } from "./NewConnectionScreen";
import { ConnectionDetail } from "./ConnectionDetail";
import { PostgisPane } from "./PostgisPane";

/**
 * The connections page and the connection form under who may add
 * database connections. While the rule holds the person back, Add
 * connection is drawn disabled with the rule's one sentence; the new
 * connection form, on its page and in Add data, draws every field and
 * Test & save disabled beside it; and a saved connection's settings keep
 * its name, user name, password and SSL editable while its host, port,
 * database and pasted URL, which would point it elsewhere, are disabled.
 * With no rule holding them back, or no rule read, each draws as it
 * always has. Every read is a fake.
 */
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: push }), usePathname: () => "/connections" }));

const SENTENCE = "Only admins can add database connections on this instance.";
const saved: PgConnection = {
  id: "c1", name: "City", host: "db.example.test", port: 5432, database: "gis", username: "reader", ssl: true,
  createdAt: "2026-09-01T00:00:00.000Z", status: "connected", lastCheckedAt: "2026-10-01T00:00:00.000Z",
  lastCheckError: null, serverVersion: "PostgreSQL 16.4", postgisVersion: "3.4.3",
};

let rule: string | null;
let admin: boolean;
let connections: PgConnection[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  rule = "everyone";
  admin = false;
  connections = [];
  host = installDomHost();
  Object.assign(host.window, {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  // next/link's intersection effect reads `self` for an idle callback, falling back to its timers.
  vi.stubGlobal("self", { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/config") {
      return rule === null ? Response.json({ error: { code: "internal", message: "Unavailable." } }, { status: 500 })
        : Response.json({ rules: { "connections.create": rule } });
    }
    if (url === "/api/account") return Response.json({ account: { id: "a1", isAdmin: admin } });
    if (url === "/api/connections/postgis") return Response.json(connections);
    if (url === "/api/connections/postgis/c1/snapshots") return Response.json({ snapshots: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  container = host.document.body.appendChild(host.document.createElement("div"));
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.document.body.removeChild(container);
  vi.unstubAllGlobals();
  host.uninstall();
});

async function mount(element: ReactElement) {
  await act(async () => root.render(element));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const buttons = (text: string) => container.querySelectorAll("button").filter(element => element.textContent.trim() === text);
/** The heading's Add connection and the empty page's tile, whose label is its bold line. */
const adds = () => container.querySelectorAll("button").filter(element =>
  element.textContent.trim() === "Add connection" || element.querySelector("b")?.textContent === "Add connection");
/** The form's input under its label's own words. */
const field = (label: string) => container.querySelectorAll("label").find(element => element.querySelector("span")?.textContent === label)?.querySelector("input");
const ssl = () => container.querySelectorAll("label").find(element => element.textContent === "Require SSL for this connection")!.querySelector("input")!;
const said = () => container.textContent.split(SENTENCE).length - 1;
async function type(input: HostElement, value: string) {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
  await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { value } }));
}

const NEW_FIELDS = ["Connection name", "Host", "Port", "Database", "Username", "Password"];

describe("who may add database connections", () => {
  describe("held back: a member under Admins only", () => {
    beforeEach(() => { rule = "admins"; });

    it("draws the page's Add connection disabled with the sentence, the empty page's tile too", async () => {
      await mount(<ConnectionsLedger />);
      expect(container.querySelector('a[href="/connections/new"]')).toBeNull();
      const held = adds();
      expect(held.length).toBe(2);
      for (const add of held) expect(add.disabled).toBe(true);
      expect(said()).toBe(1);
    });

    it("keeps a listed connection's Test while Add connection is held", async () => {
      connections = [saved];
      await mount(<ConnectionsLedger />);
      expect(adds().map(add => add.disabled)).toEqual([true]);
      expect(buttons("Test")[0].disabled).toBe(false);
      expect(said()).toBe(1);
    });

    it("draws the new connection form disabled with the sentence, on its page and in Add data", async () => {
      for (const [index, screen] of [<NewConnectionScreen key="page" />, <PostgisPane key="pane" onTableCreated={() => {}} />].entries()) {
        if (index > 0) { await act(async () => root.unmount()); root = createRoot(container as unknown as Element); }
        await mount(screen);
        for (const label of NEW_FIELDS) expect(field(label)!.disabled, label).toBe(true);
        expect(field("Paste a connection URL optional")!.disabled).toBe(true);
        expect(ssl().disabled).toBe(true);
        expect(buttons("Test & save connection")[0].disabled).toBe(true);
        expect(said()).toBe(1);
      }
    });

    it("keeps a saved connection's name, user, password and SSL and holds what points it elsewhere", async () => {
      connections = [saved];
      await mount(<ConnectionDetail id="c1" />);
      for (const label of ["Host", "Port", "Database"]) expect(field(label)!.disabled, label).toBe(true);
      expect(buttons("Paste a new connection URL")[0].disabled).toBe(true);
      for (const label of ["Connection name", "Username", "Password"]) expect(field(label)!.disabled, label).toBe(false);
      expect(ssl().disabled).toBe(false);
      await type(field("Connection name")!, "City archive");
      expect(buttons("Test & save changes")[0].disabled).toBe(false);
      expect(said()).toBe(1);
    });
  });

  for (const [value, who] of [["everyone", "a member"], ["admins", "an admin"], [null, "a member, the rule unread,"]] as const) {
    it(`draws as it always has for ${who} under ${value ?? "no rule"}`, async () => {
      rule = value;
      admin = who === "an admin";
      await mount(<ConnectionsLedger />);
      expect(container.querySelector('a[href="/connections/new"]')).not.toBeNull();
      expect(adds().map(add => add.disabled)).toEqual([false]);
      expect(said()).toBe(0);
      await act(async () => root.unmount());
      root = createRoot(container as unknown as Element);
      await mount(<NewConnectionScreen />);
      for (const label of NEW_FIELDS) expect(field(label)!.disabled, label).toBe(false);
      expect(field("Paste a connection URL optional")!.disabled).toBe(false);
      expect(said()).toBe(0);
      await act(async () => root.unmount());
      root = createRoot(container as unknown as Element);
      connections = [saved];
      await mount(<ConnectionDetail id="c1" />);
      for (const label of ["Host", "Port", "Database"]) expect(field(label)!.disabled, label).toBe(false);
      expect(buttons("Paste a new connection URL")[0].disabled).toBe(false);
      expect(said()).toBe(0);
      connections = [];
    });
  }
});

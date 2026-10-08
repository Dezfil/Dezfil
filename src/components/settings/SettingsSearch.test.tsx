import { act, type ReactNode } from "react";
import { defaultLook } from "@/lib/look";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { openPrivateState } from "../auth/private-state";
import { storedRead } from "./read-fixture";
import { SettingsFrame } from "./SettingsFrame";
import { settingsDeclarations } from "./settings-index";
import type { SettingsTabId } from "./settings-tabs";

/**
 * The search on the Settings page: `/` to the field, the answer in the
 * tab's place, the keys that walk it, a hit opening its tab with the row
 * marked (asking first when the tab holds unsaved text), a member's
 * scope, and the passwords and token secrets it never reads. The reads
 * are faked; nothing here reaches a server.
 */

const nav = vi.hoisted(() => ({ pathname: "/settings", hash: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.push, prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className, id, "aria-current": current }: {
    href: string; children: ReactNode; className?: string; id?: string; "aria-current"?: "page";
  }) => <a href={href} id={id} className={className} aria-current={current}>{children}</a>,
}));

const PASSWORD = "seeded-Password-4711", SECRET = "dz_seededTokenSecret_0042";
/** The person's look as the own-settings read reports it. */
const LOOK = { ...defaultLook(), color: "slate", background: "hex" };
/** What the configuration read reports stored. */
const STORED = { instanceName: "Atlas North", landingPage: "maps", queryTimeoutS: 90, "newLayer.colorCycle": "tab10" };
let admin = true;
let tokens: { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[];
let requests: string[];
const scrolled: string[] = [];
Object.assign(HostElement.prototype, { scrollIntoView(this: HostElement) { scrolled.push(this.id); } });
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let themeButton: HostElement;

beforeEach(() => {
  requests = []; scrolled.length = 0; admin = true;
  tokens = [{ id: "t1", name: "Laptop CLI", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null }];
  nav.pathname = "/settings"; nav.hash = "";
  nav.replace = vi.fn((address: string) => {
    const at = address.indexOf("#");
    nav.pathname = at < 0 ? address : address.slice(0, at);
    nav.hash = at < 0 ? "" : address.slice(at);
  });
  nav.push = vi.fn();
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === "/api/account") {
      return Response.json({ account: { id: "ada", name: "Ada Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: admin } });
    }
    if (url === "/api/instance/settings") {
      // The read answers a moment later than the tab asks, as a server does.
      await new Promise(resolve => setTimeout(resolve, 5));
      return Response.json(storedRead(STORED));
    }
    if (url === "/api/auth/entry") return Response.json({ instanceName: "Atlas North", signInMessage: "", lostPasswordContact: "the GIS team", landingPage: "projects", setupRequired: false });
    if (url === "/api/health") return Response.json({ status: "ready" });
    if (url === "/api/assistant") return Response.json({ enabled: false, reason: "No model credential is configured." });
    if (url === "/api/account/tokens" && init?.method === "POST") {
      const token = { id: "t2", name: JSON.parse(String(init.body)).name, createdAt: "2026-10-07T00:00:00.000Z", lastUsedAt: null, revokedAt: null };
      tokens = [...tokens, token];
      return Response.json({ ...token, secret: SECRET });
    }
    if (url === "/api/account/tokens") return Response.json({ tokens });
    if (url === "/api/settings") return Response.json({ displayName: "Ada Okafor", instanceName: null, viewPrefs: {}, sourceGrouping: "kind", look: LOOK });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  openPrivateState("ada");
  host = installDomHost();
  Object.assign(host.window, {
    location: { get hash() { return nav.hash; }, get pathname() { return nav.pathname; }, get href() { return `https://dezfil.example${nav.pathname}${nav.hash}`; }, origin: "https://dezfil.example" },
    history: { state: null as unknown, pushState(this: { state: unknown }, state: unknown) { this.state = state; }, back: vi.fn(), go: vi.fn() },
  });
  themeButton = host.document.createElement("button");
  themeButton.setAttribute("aria-label", "Switch between dark and light theme");
  host.document.body.appendChild(themeButton);
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 6)); });
}
async function open(pathname: string, as: "admin" | "member" = "admin") {
  admin = as === "admin";
  nav.pathname = pathname; nav.hash = "";
  await act(async () => root.render(<SettingsFrame />));
  await settle();
}
/** The router arrived at the address the frame asked for. */
async function arrive(address: string) {
  const at = address.indexOf("#");
  nav.pathname = at < 0 ? address : address.slice(0, at); nav.hash = at < 0 ? "" : address.slice(at);
  await act(async () => root.render(<SettingsFrame />));
  await settle();
}

function props(element: HostElement) {
  const key = Object.keys(element).find(name => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[key];
}
const field = () => container.querySelectorAll("input").find(input => input.getAttribute("aria-label") === "Search settings")!;
const search = (text: string) => act(async () => props(field()).onChange({ target: { value: text } }));
async function find(text: string) { await search(text); await settle(); }
const key = (element: HostElement, name: string) => act(async () => props(element).onKeyDown({ key: name, preventDefault() {}, currentTarget: element }));
const answer = () => container.querySelectorAll("h2").find(h2 => h2.getAttribute("id") === "settings-search-heading");
const results = () => answer()?.parentElement?.querySelectorAll("button") ?? [];
const lines = () => results().map(button => button.children[0].children[0].textContent);
const metas = () => results().map(button => button.children[0].children[1]?.textContent ?? "");
const tabContent = () => container.querySelector("[data-tab]")!;
const active = () => host.document.activeElement;
const column = () => container.querySelector("nav")!;
async function type(label: string, text: string) {
  const tag = container.querySelectorAll("label").find(element => element.textContent === label)!;
  const input = container.querySelector(`[id="${tag.getAttribute("for")}"]`)!;
  await act(async () => props(input).onChange({ target: { value: text } }));
}
const choose = async (line: string) => {
  await act(async () => { results().find(button => button.children[0].children[0].textContent === line)!.click(); });
  await settle();
};

describe("the Settings search", () => {
  it("puts the field at the head of the column and focuses it with /, never while typing in a field", async () => {
    await open("/settings/account");
    expect(column().querySelectorAll("input")[0]).toBe(field());
    expect(field().getAttribute("placeholder")).toBe("Search settings");
    // A field outside the page's own tree: the key reaches the document without React reading it.
    const elsewhere = host.document.createElement("input");
    host.document.body.appendChild(elsewhere);
    const slash = (target: HostElement) => {
      const event = Object.assign(new HostEvent("keydown", { bubbles: true, cancelable: true }), { key: "/" });
      target.dispatchEvent(event);
      return event;
    };
    elsewhere.focus();
    expect(slash(elsewhere).defaultPrevented).toBe(false);
    expect(active()).toBe(elsewhere);
    expect(slash(host.document.body).defaultPrevented).toBe(true);
    expect(active()).toBe(field());
  });

  it("answers in the tab's place as Group / Tab · Row with the card and the value, and clearing returns to the tab", async () => {
    await open("/settings/account");
    await find("query time");
    expect(tabContent().hasAttribute("hidden")).toBe(true);
    expect(column().querySelectorAll('a[aria-current="page"]')).toEqual([]);
    expect(answer()?.textContent).toBe("2 results for “query time”");
    expect(lines()).toEqual(["Instance / Limits · Query time limit", "Instance / System · Query time limit"]);
    expect(metas()).toEqual(["Queries · 90 seconds", "Server settings · 90 seconds"]);
    expect(results()[0].querySelector("mark")?.textContent).toBe("Query time");
    await act(async () => { container.querySelectorAll("button").find(button => button.getAttribute("aria-label") === "Clear the search")!.click(); });
    expect(field().value).toBe("");
    expect(active()).toBe(field());
    expect(answer()).toBeUndefined();
    expect(tabContent().hasAttribute("hidden")).toBe(false);
    expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Account"]);
  });

  it("finds a value's words and a variable's name, and says when nothing matches", async () => {
    await open("/settings/account");
    await find("atlas north");
    expect(lines()).toContain("Instance / General · Instance name");
    await find("DEZFIL_QUERY_TIMEOUT_S");
    expect(lines()).toEqual(["Instance / System · Query time limit"]);
    await find("zebra crossing");
    expect(answer()?.textContent).toBe("No settings match “zebra crossing”");
    expect(results()).toEqual([]);
  });

  it("walks the hits with the arrows, goes back to the field with Escape or from the first hit, and Escape in the field clears it", async () => {
    await open("/settings/account");
    await find("time limit");
    const [first, second] = results();
    await key(field(), "ArrowDown");
    expect(active()).toBe(first);
    await key(first, "ArrowDown");
    expect(active()).toBe(second);
    await key(second, "ArrowUp");
    expect(active()).toBe(first);
    await key(first, "ArrowUp");
    expect(active()).toBe(field());
    await key(field(), "ArrowDown");
    await key(results()[0], "Escape");
    expect(active()).toBe(field());
    expect(field().value).toBe("time limit");
    await key(field(), "Escape");
    expect(field().value).toBe("");
    expect(answer()).toBeUndefined();
  });

  it("finds a field by the text typed in it and not yet saved", async () => {
    await open("/settings/account");
    await type("Display name", "Ada Lovelace");
    await find("lovelace");
    expect(lines()).toEqual(["You / Account · Display name"]);
    expect(metas()).toEqual(["Account · Ada Lovelace"]);
    await find("");
    await arrive("/settings/general");
    await type("Message", "Bring your badge.");
    await find("badge");
    expect(lines()).toEqual(["Instance / General · Message"]);
    expect(metas()).toEqual(["Sign-in · Bring your badge."]);
  });

  it("opens a hit's tab and marks its row once the tab's read has drawn it", async () => {
    await open("/settings/account");
    await find("rows shown");
    await choose("Instance / Limits · Rows shown in results");
    expect(nav.push).toHaveBeenCalledWith("/settings/limits#set-preview-rows", { scroll: false });
    expect(field().value).toBe("");
    await arrive("/settings/limits#set-preview-rows");
    const row = container.querySelector('[id="set-preview-rows"]')!;
    expect(row.hasAttribute("data-marked")).toBe(true);
    expect(scrolled).toContain("set-preview-rows");
  });

  it("opens Maps, Workflows & SQL and Publishing from a hit, each with its row marked once drawn", async () => {
    await open("/settings/account");
    const hits = [
      ["point radius", "Instance / Maps · Point radius", "/settings/maps#set-point-radius"],
      ["minimap", "Instance / Workflows & SQL · Minimap", "/settings/workflows#set-minimap"],
      ["starting shape", "Instance / Publishing · Starting shape", "/settings/publishing#set-export-shape"],
    ] as const;
    for (const [query, line, address] of hits) {
      await find(query);
      await choose(line);
      expect(nav.push).toHaveBeenLastCalledWith(address, { scroll: false });
      expect(field().value).toBe("");
      await arrive(address);
      const anchor = address.slice(address.indexOf("#") + 1);
      expect(container.querySelector(`[id="${anchor}"]`)!.hasAttribute("data-marked"), line).toBe(true);
      expect(scrolled).toContain(anchor);
      expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual([line.split(" / ")[1].split(" · ")[0]]);
    }
  });

  it("finds a row of what new things start with by the words of its kept value, with its card", async () => {
    await open("/settings/account");
    await find("tab10");
    expect(lines()).toEqual(["Instance / Maps · Color cycle"]);
    expect(metas()).toEqual(["New layers · Tab10"]);
    await find("text size");
    expect(lines()).toEqual(["Instance / Workflows & SQL · Text size"]);
    expect(metas()).toEqual(["SQL console · 12 px"]);
  });

  it("marks a hit's row on the tab already open without leaving it", async () => {
    await open("/settings/limits");
    await find("images at once");
    await choose("Instance / Limits · Images at once");
    expect(nav.push).not.toHaveBeenCalled();
    expect(tabContent().hasAttribute("hidden")).toBe(false);
    expect(container.querySelector('[id="set-images-at-once"]')!.hasAttribute("data-marked")).toBe(true);
  });

  it("asks before a hit leaves a tab with unsaved typed text, and stays when told to", async () => {
    await open("/settings/account");
    await type("Display name", "Ada Lovelace");
    await find("landing");
    await choose("Instance / General · Landing page");
    const dialog = host.document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Account has changes that are not saved.");
    await act(async () => { dialog.querySelectorAll("button").find(button => button.textContent === "Keep editing")!.click(); });
    expect(nav.push).not.toHaveBeenCalled();
    expect(field().value).toBe("landing");
  });

  it("points at the header's light or dark button, and at Users for an admin", async () => {
    await open("/settings/account");
    await find("dark");
    await choose("Header / Light or dark");
    expect(themeButton.style.getPropertyValue("background-color")).toBe("var(--accent-wash)");
    await find("invite");
    expect(lines()).toEqual(["Side menu / Users"]);
    await choose("Side menu / Users");
    expect(container.querySelector('[id="settings-users"]')!.hasAttribute("data-marked")).toBe(true);
  });

  it("gives a member only the member's tabs: never Maps, Workflows & SQL, Publishing, Limits, System or Users, and never the configuration read", async () => {
    await open("/settings/account", "member");
    for (const query of ["limit", "system", "users", "invite", "environment", "version", "maps", "basemap", "opacity", "workflows",
      "minimap", "text size", "publishing", "starting width", "tab10"]) {
      await find(query);
      expect(lines().filter(line => /Maps|Workflows|Publishing|Limits|System|Users/.test(line)), query).toEqual([]);
    }
    await find("gis team");
    expect(lines()).toEqual(["Instance / General · Lost password contact"]);
    expect(requests).not.toContain("/api/instance/settings");
  });
});

describe("where a hit lands", () => {
  it("names only cards and rows its tab draws, under the same id and label", async () => {
    const declared = settingsDeclarations({
      account: { id: "ada", name: "Ada Okafor", email: "ada@example.test", sqlName: "ada_okafor", isAdmin: true } as never,
      tokens, look: LOOK, instance: storedRead(STORED), entry: null,
      health: "ready", assistant: { enabled: false, reason: "No model credential is configured." },
    }, true);
    const tabs: SettingsTabId[] = ["account", "tokens", "appearance", "general", "maps", "workflows", "publishing", "limits", "system"];
    expect(Object.keys(declared).sort()).toEqual([...tabs].sort());
    for (const tab of tabs) {
      await arrive(`/settings/${tab}`);
      expect(declared[tab]!.length, tab).toBeGreaterThan(0);
      for (const card of declared[tab]!) {
        expect(tabContent().querySelector(`[id="${card.id}"]`), `${tab}: ${card.id}`).not.toBeNull();
        for (const row of card.rows.filter(row => !row.secret)) {
          expect(tabContent().querySelector(`[id="${row.id}"]`)?.textContent, `${tab}: ${row.id}`).toContain(row.label);
        }
      }
    }
  });
});

describe("what the search never finds", () => {
  it("finds no password typed on the page, by its value or its field", async () => {
    await open("/settings/account");
    await act(async () => { (container.querySelector('[id="password"]') as unknown as { open: boolean }).open = true; });
    await type("Current password", PASSWORD);
    await type("New password", PASSWORD);
    await type("Email", "ada.okafor@example.test");
    await type("Current password to change email", PASSWORD);
    for (const query of [PASSWORD, "seeded"]) {
      await find(query);
      expect(lines()).toEqual([]);
    }
    // The email typed beside them is found by what it holds now.
    await find("ada.okafor");
    expect(lines()).toEqual(["You / Account · Email"]);
    // The fields themselves are not listed; the disclosure that holds them is.
    await find("new password");
    expect(lines()).toEqual(["You / Account · Change password"]);
  });

  it("finds a new token by its name and never by its secret, on screen or not", async () => {
    await open("/settings/tokens");
    await type("Token name", "Build server");
    await act(async () => { container.querySelectorAll("form").find(form => form.textContent.includes("Create token"))!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(container.textContent).toContain("Copy this token now.");
    expect(container.querySelectorAll("input").some(input => input.value === SECRET)).toBe(true);
    for (const query of [SECRET, "dz_"]) {
      await find(query);
      expect(lines()).toEqual([]);
    }
    await find("new token");
    expect(lines()).not.toContain("You / Tokens · New token");
    await find("build server");
    expect(lines()[0]).toBe("You / Tokens · Build server");
    expect(metas()[0]).toBe("API / MCP tokens · Never used");
  });
});

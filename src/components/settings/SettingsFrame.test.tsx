import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, HostEvent, installDomHost } from "../testing/dom-host";
import { openPrivateState } from "../auth/private-state";
import { endTraversalsWith, traversalKept, traversalTaken } from "../auth/kept-traversals";
import { DISPLAY_NAME_EVENT } from "../UserBadge";
import { readLastTab, writeLastTab } from "./last-tab";
import { storageReadFixture, storedRead } from "./read-fixture";
import { SettingsFrame } from "./SettingsFrame";

/**
 * The frame over the shipped cards: who sees which tab, where each
 * address lands, the shipped fragment links, and the tab this browser
 * session reopens. The reads are faked; nothing here reaches a server.
 */

const nav = vi.hoisted(() => ({ pathname: "/settings", hash: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.push, prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-current": current }: {
    href: string; children: ReactNode; className?: string; "aria-current"?: "page";
  }) => <a href={href} className={className} aria-current={current}>{children}</a>,
}));

const requests: string[] = [];
/** What scrolled into view: the host computes no layout, so a scroll is a recorded call. */
const scrolled: string[] = [];
Object.assign(HostElement.prototype, { scrollIntoView(this: HostElement) { scrolled.push(this.id); } });
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

/** The browser's history as the page sees it: the state of the entry on
 * screen, the entries the page added, and the steps it asked for. */
const browser = { state: null as unknown, pushed: [] as unknown[], steps: [] as number[] };
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let admin = true;
let accountName = "Ada Okafor";
let instanceName = "Atlas";
/** Where the browser is when it has moved without the router hearing it. */
let shownAt: string | null = null;
/** While set, a token's creation waits for the test to answer it. */
let holdCreation = false;
let answerCreation: (() => void) | null = null;
/** While set, every read (or every read of `only`) waits until the test lets it through (`gate.open`). */
let gate: { wait: Promise<void>; open: () => void; reads: string[]; only: readonly string[] | null } | null = null;
/** The account's read waits on the gate too while this holds. */
let gateAccount = false;

beforeEach(() => {
  requests.length = 0; scrolled.length = 0; accountName = "Ada Okafor"; instanceName = "Atlas"; shownAt = null; holdCreation = false; answerCreation = null;
  gate = null; gateAccount = false;
  nav.pathname = "/settings"; nav.hash = ""; nav.replace = vi.fn((address: string) => {
    const at = address.indexOf("#");
    nav.pathname = at < 0 ? address : address.slice(0, at);
    nav.hash = at < 0 ? "" : address.slice(at);
  });
  nav.push = vi.fn();
  browser.state = null; browser.pushed = []; browser.steps = [];
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    const waiting = gate;
    if (waiting && (init?.method ?? "GET") === "GET" && (url !== "/api/account" || gateAccount) && (!waiting.only || waiting.only.includes(url))) {
      waiting.reads.push(url);
      await waiting.wait;
    }
    if (url === "/api/account") {
      return Response.json({ account: { id: "ada", name: accountName, email: "ada@example.test", sqlName: "ada", isAdmin: admin } });
    }
    if (url === "/api/config") return Response.json({ externalSignIn: { enabled: false }, passwordMin: 8 });
    if (url === "/api/instance/settings") return Response.json(storedRead({ instanceName }));
    if (url === "/api/auth/entry") {
      return Response.json({ instanceName, signInMessage: "", lostPasswordContact: "", landingPage: "home", setupRequired: false });
    }
    if (url === "/api/account/tokens" && init?.method === "POST") {
      if (holdCreation) await new Promise<void>(resolve => { answerCreation = resolve; });
      return Response.json({ id: "t1", name: "CLI", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null, secret: "dz_secret_once" });
    }
    if (url === "/api/account/tokens") return Response.json({ tokens: [] });
    if (url === "/api/settings") return Response.json({ displayName: accountName, instanceName: null, viewPrefs: {}, sourceGrouping: "kind", look: {} });
    if (url === "/api/assistant") return Response.json({ enabled: false, reason: "No model key is set." });
    if (url === "/api/health") return Response.json({ status: "ok" });
    if (url === "/api/instance/storage") return Response.json(storageReadFixture());
    if (url === "/api/palettes") return Response.json({ custom: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  openPrivateState("ada");
  host = installDomHost();
  Object.assign(host.window, {
    location: {
      get hash() { return nav.hash; }, get pathname() { return nav.pathname; },
      get href() { return `https://dezfil.example${shownAt ?? nav.pathname + nav.hash}`; }, origin: "https://dezfil.example",
    },
    history: {
      get state() { return browser.state; },
      pushState: (state: unknown) => { browser.state = state; browser.pushed.push(state); },
      back: () => { browser.steps.push(-1); },
      go: (delta: number) => { browser.steps.push(delta); },
    },
  });
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
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function open(pathname: string, hash = "", as: "admin" | "member" = "admin") {
  admin = as === "admin";
  nav.pathname = pathname; nav.hash = hash;
  await act(async () => root.render(<SettingsFrame />));
  await settle();
}
/** The address changed under the frame, as the router reports it. */
async function follow() {
  await act(async () => root.render(<SettingsFrame />));
  await settle();
}

const column = () => container.querySelector("nav")!;
const columnLinks = () => column().querySelectorAll("a").map(a => ({ text: a.textContent, href: a.getAttribute("href") }));
const byId = (id: string) => container.querySelector(`[id="${id}"]`);
/** The tab on screen, beside the column (whose head is the search field). */
const tabContent = () => container.querySelector("[data-tab]")!;

describe("the Settings frame", () => {
  it("draws the heading and, for an admin, You and Instance whole with Users at the foot", async () => {
    await open("/settings/account");
    expect(container.querySelector("h1")?.textContent).toBe("Settings");
    expect(column().getAttribute("aria-label")).toBe("Settings");
    expect(columnLinks()).toEqual([
      { text: "Account", href: "/settings/account" },
      { text: "API & MCP", href: "/settings/tokens" },
      { text: "Assistant", href: "/settings/assistant" },
      { text: "Appearance", href: "/settings/appearance" },
      { text: "General", href: "/settings/general" },
      { text: "Maps", href: "/settings/maps" },
      { text: "Libraries", href: "/settings/libraries" },
      { text: "Workflows & SQL", href: "/settings/workflows" },
      { text: "Publishing", href: "/settings/publishing" },
      { text: "Data & services", href: "/settings/data" },
      { text: "Limits", href: "/settings/limits" },
      { text: "Security", href: "/settings/security" },
      { text: "System", href: "/settings/system" },
      { text: "Users", href: "/users" },
    ]);
    // Every tab in the column has its glyph.
    expect(column().querySelectorAll("a").every(a => a.querySelector("svg") !== null)).toBe(true);
    expect(column().textContent).toContain("You");
    expect(column().textContent).toContain("Instance");
  });

  it("draws Maps, Workflows & SQL and Publishing for an admin, each marked in the column, from the configuration read", async () => {
    await open("/settings/maps");
    const current = () => column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent);
    expect(current()).toEqual(["Maps"]);
    expect(tabContent().getAttribute("data-tab")).toBe("maps");
    expect(["card-new-maps", "card-legend", "card-new-layers"].map(id => byId(id)?.tagName)).toEqual(["SECTION", "SECTION", "SECTION"]);
    nav.pathname = "/settings/workflows"; await follow();
    expect(current()).toEqual(["Workflows & SQL"]);
    expect(["card-workflow-canvas", "card-sql-console"].map(id => byId(id)?.tagName)).toEqual(["SECTION", "SECTION"]);
    expect(byId("card-new-maps")).toBeNull();
    nav.pathname = "/settings/publishing"; await follow();
    expect(current()).toEqual(["Publishing"]);
    expect(byId("publishing-export")?.tagName).toBe("SECTION");
    expect(readLastTab()).toBe("publishing");
    expect(requests).toContain("/api/instance/settings");
  });

  it("draws Libraries for an admin, marked in the column, from the configuration and palette reads", async () => {
    await open("/settings/libraries");
    expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Libraries"]);
    expect(tabContent().getAttribute("data-tab")).toBe("libraries");
    expect(["card-basemaps", "card-satellite", "card-palettes"].map(id => byId(id)?.tagName)).toEqual(["SECTION", "SECTION", "SECTION"]);
    expect(requests).toContain("/api/instance/settings");
    expect(requests).toContain("/api/palettes");
    expect(readLastTab()).toBe("libraries");
  });

  it("shows a member Account, API & MCP, Assistant, Appearance and General only, and never makes the configuration read", async () => {
    await open("/settings/general", "", "member");
    expect(columnLinks().map(link => link.text)).toEqual(["Account", "API & MCP", "Assistant", "Appearance", "General"]);
    expect(requests).not.toContain("/api/instance/settings");
    expect(requests.every(url => !url.startsWith("/api/instance"))).toBe(true);
  });

  it("opens Account for a member at the addresses of Maps, Libraries, Workflows & SQL, Publishing and Data & services, rows included, and never reads the configuration or the palettes", async () => {
    await open("/settings/maps", "", "member");
    expect(nav.replace).toHaveBeenLastCalledWith("/settings/account", { scroll: false });
    expect(byId("account")?.tagName).toBe("SECTION");
    for (const [pathname, hash] of [["/settings/workflows", "#set-minimap"], ["/settings/publishing", "#set-export-width"], ["/settings/maps", "#set-basemap"],
      ["/settings/data", "#set-geocoder-address"], ["/settings/data", ""], ["/settings/libraries", "#set-custom-styles"], ["/settings/libraries", "#card-palettes"]]) {
      nav.pathname = pathname; nav.hash = hash; await follow();
      expect(nav.replace).toHaveBeenLastCalledWith("/settings/account", { scroll: false });
      expect(byId("account")?.tagName).toBe("SECTION");
      expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Account"]);
    }
    expect(columnLinks().map(link => link.text)).toEqual(["Account", "API & MCP", "Assistant", "Appearance", "General"]);
    for (const id of ["card-new-maps", "card-workflow-canvas", "publishing-export", "set-minimap", "set-export-width", "set-basemap",
      "data-geocoder", "set-geocoder-address", "data-who", "card-basemaps", "card-satellite", "card-palettes", "set-custom-styles"]) expect(byId(id)).toBeNull();
    expect(requests.every(url => !url.startsWith("/api/instance"))).toBe(true);
    expect(requests).not.toContain("/api/palettes");
    expect(readLastTab()).toBe("account");
  });

  it("marks the tab on screen in the column", async () => {
    await open("/settings/tokens");
    const current = column().querySelectorAll('a[aria-current="page"]');
    expect(current.map(a => a.textContent)).toEqual(["API & MCP"]);
  });

  it("draws the tokens card, then the MCP server card, on API & MCP", async () => {
    await open("/settings/tokens");
    expect(tabContent().querySelectorAll("section").map(section => section.getAttribute("id"))).toEqual(["tokens", "mcp"]);
  });

  it("lands the API reference page's link on the MCP server card", async () => {
    await open("/settings/tokens", "#mcp-heading");
    expect(byId("mcp-heading")!.closest("section")!.hasAttribute("data-marked")).toBe(true);
    expect(scrolled).toEqual(["mcp"]);
  });

  it("keeps the shipped cards rendering inside their tabs", async () => {
    await open("/settings/account");
    expect(byId("account")?.tagName).toBe("SECTION");
    expect(byId("password")?.tagName).toBe("DETAILS");
    expect(byId("tokens-heading")).toBeNull();
    nav.pathname = "/settings/tokens"; await follow();
    expect(byId("tokens-heading")?.textContent).toBe("API / MCP tokens");
    expect(byId("account")).toBeNull();
    nav.pathname = "/settings/general"; await follow();
    expect(container.querySelector('[id="instance-heading"]')?.textContent).toBe("Instance");
  });

  it("opens Account for an address of a tab the person cannot see", async () => {
    await open("/settings/limits", "", "member");
    expect(nav.replace).toHaveBeenCalledWith("/settings/account", { scroll: false });
    expect(byId("account")).not.toBeNull();
    expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Account"]);
  });

  it("lands the shipped password link on Account with Change password open and marked", async () => {
    await open("/settings", "#password");
    expect(nav.replace).toHaveBeenCalledWith("/settings/account#password", { scroll: false });
    const details = byId("password") as unknown as HostElement & { open?: boolean };
    expect(details.open).toBe(true);
    expect(details.hasAttribute("data-marked")).toBe(true);
    expect(scrolled).toContain("password");
  });

  it("lands the shipped tokens link on the tokens heading", async () => {
    await open("/settings", "#tokens-heading");
    expect(nav.replace).toHaveBeenCalledWith("/settings/tokens#tokens-heading", { scroll: false });
    const card = byId("tokens-heading")!.closest("section")!;
    expect(card.hasAttribute("data-marked")).toBe(true);
    expect(scrolled).toEqual(["tokens"]);
  });

  it("reopens the tab last open in this browser session at the bare address", async () => {
    writeLastTab("tokens");
    await open("/settings");
    expect(nav.replace).toHaveBeenCalledWith("/settings/tokens", { scroll: false });
    expect(byId("tokens-heading")).not.toBeNull();
    nav.pathname = "/settings/system"; await follow();
    expect(readLastTab()).toBe("system");
  });

  it("opens Account at the bare address when nothing was open in this session", async () => {
    await open("/settings");
    expect(nav.replace).toHaveBeenCalledWith("/settings/account", { scroll: false });
    expect(readLastTab()).toBe("account");
  });

  it("follows back and forward between tab addresses without a second read of the account", async () => {
    await open("/settings/account");
    const reads = requests.filter(url => url === "/api/account").length;
    nav.pathname = "/settings/limits"; await follow();
    nav.pathname = "/settings/account"; await follow();
    expect(requests.filter(url => url === "/api/account").length).toBe(reads);
    expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Account"]);
  });

  it("shows what a card saved when its tab opens again", async () => {
    await open("/settings/account");
    accountName = "Ada Lovelace";
    await act(async () => { host.window.dispatchEvent(new CustomEvent(DISPLAY_NAME_EVENT, { detail: "Ada Lovelace" })); });
    await settle();
    nav.pathname = "/settings/tokens"; await follow();
    nav.pathname = "/settings/account"; await follow();
    // The account card's display name, the first field it saves.
    expect(tabContent().querySelector('input[data-unit-key="name"]')?.value).toBe("Ada Lovelace");
    nav.pathname = "/settings/general"; await follow();
    expect(tabContent().querySelector("input")?.value).toBe("Atlas");
    // General reads the instance afresh each time it opens.
    instanceName = "Atlas North";
    nav.pathname = "/settings/tokens"; await follow();
    nav.pathname = "/settings/general"; await follow();
    expect(tabContent().querySelector("input")?.value).toBe("Atlas North");
  });

  it("gives a member General from the entry read, disabled", async () => {
    await open("/settings/general", "", "member");
    expect(requests).toContain("/api/auth/entry");
    expect(tabContent().querySelector("input")?.disabled).toBe(true);
    expect(container.textContent).toContain("Only admins can change the instance name.");
  });

  it("takes only the router's next answer for the address it asked for", async () => {
    await open("/settings/limits", "#not a row");
    expect(nav.replace).toHaveBeenCalledWith("/settings/limits", { scroll: false });
    nav.pathname = "/settings/tokens"; await follow();
    nav.pathname = "/settings/limits"; await follow();
    expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Limits"]);
  });
});

describe("changing tabs", () => {
  /** Hold every read from here on (or every read of `only`) until the test opens the gate. */
  function closeGate(only: readonly string[] | null = null) {
    let open!: () => void;
    const wait = new Promise<void>(resolve => { open = resolve; });
    gate = { wait, open, reads: [], only };
    return gate;
  }
  /** Let the held reads through, and their answers land. */
  async function openGate() {
    const waiting = gate!;
    gate = null;
    await act(async () => { waiting.open(); });
    await settle();
  }
  const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  /** The router reports a new address; nothing it reads is waited for. */
  async function change(pathname: string, hash = "") {
    nav.pathname = pathname; nav.hash = hash;
    await act(async () => root.render(<SettingsFrame />));
  }
  const slots = () => container.querySelectorAll("[data-tab]");
  const tabOf = (slot: HostElement) => slot.getAttribute("data-tab");
  const slot = (tab: string) => slots().find(element => tabOf(element) === tab);
  /** The tabs on screen: in the pane and not hidden. */
  const shown = () => slots().filter(element => !element.hasAttribute("hidden"));
  const shownText = () => shown().map(element => element.textContent).join("");
  const current = () => column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent);

  it("keeps the tab on screen while the next one reads out of sight, then shows it whole and lets the first go in the same step", async () => {
    await open("/settings/account");
    closeGate();
    await change("/settings/limits");
    await pause(16);
    // The column follows the click at once.
    expect(current()).toEqual(["Limits"]);
    expect(shown().map(tabOf)).toEqual(["account"]);
    expect(slot("limits")?.hasAttribute("hidden")).toBe(true);
    expect(shownText()).not.toContain("Loading");
    await openGate();
    expect(slots().map(tabOf)).toEqual(["limits"]);
    expect(shown().map(tabOf)).toEqual(["limits"]);
    expect(byId("limits-public")).not.toBeNull();
    expect(byId("account")).toBeNull();
  });

  it("shows the next tab in its own loading state once 300 ms pass without its reads, and never a loading line before", async () => {
    await open("/settings/account");
    closeGate();
    await change("/settings/limits");
    await pause(150);
    expect(shown().map(tabOf)).toEqual(["account"]);
    expect(shownText()).not.toContain("Loading");
    await pause(200);
    expect(slots().map(tabOf)).toEqual(["limits"]);
    expect(shownText()).toBe("Loading settings…");
    await openGate();
    expect(byId("limits-public")).not.toBeNull();
  });

  it("waits for every first read of a tab: System shows once its configuration, assistant and health reads have landed", async () => {
    await open("/settings/account");
    closeGate(["/api/health"]);
    await change("/settings/system");
    await settle();
    // The configuration and the assistant have answered; the health read has not.
    expect(shown().map(tabOf)).toEqual(["account"]);
    expect(slot("system")?.querySelector('[id="sys-assistant-status"]')).not.toBeNull();
    await openGate();
    expect(shown().map(tabOf)).toEqual(["system"]);
    expect(byId("sys-assistant-status")).not.toBeNull();
    expect(byId("sys-data-folder")?.querySelector("[data-state]")?.textContent).toBe("Writable");
    expect(shownText()).not.toContain("Loading");
    expect(shownText()).not.toContain("Checking");
  });

  it("marks and scrolls to the row an address names only once its tab is shown", async () => {
    await open("/settings/account");
    closeGate(["/api/assistant", "/api/health"]);
    await change("/settings/system", "#sys-version");
    await settle();
    // The row is drawn out of sight; nothing lands on it there.
    expect(slot("system")?.querySelector('[id="sys-version"]')).not.toBeNull();
    expect(scrolled).toEqual([]);
    expect(container.querySelectorAll("[data-marked]")).toEqual([]);
    await openGate();
    expect(scrolled).toEqual(["sys-version"]);
    expect(byId("sys-version")!.hasAttribute("data-marked")).toBe(true);
  });

  it("mounts each tab once: a tab passed over before it was ready goes, and only the tab shown stays", async () => {
    await open("/settings/account");
    closeGate();
    await change("/settings/limits");
    await change("/settings/system");
    expect(slots().map(tabOf)).toEqual(["account", "system"]);
    await change("/settings/account");
    expect(slots().map(tabOf)).toEqual(["account"]);
    await change("/settings/tokens");
    await openGate();
    expect(slots().map(tabOf)).toEqual(["tokens"]);
    expect(container.querySelectorAll('[id="tokens"]')).toHaveLength(1);
  });

  it("opens the first tab of a visit out of sight: blank until its reads land, in its loading state after 300 ms", async () => {
    closeGate();
    await open("/settings/limits");
    // Nothing on screen beside the column: the tab reads out of sight.
    expect(shown()).toEqual([]);
    expect(slot("limits")?.hasAttribute("hidden")).toBe(true);
    expect(shownText()).toBe("");
    // The tab's own loading line is drawn, out of sight with it.
    const statuses = container.querySelectorAll('[role="status"]');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every(status => status.closest("[data-tab]")?.hasAttribute("hidden"))).toBe(true);
    await pause(320);
    expect(shownText()).toBe("Loading settings…");
    await openGate();
    expect(byId("limits-public")).not.toBeNull();
    expect(shownText()).not.toContain("Loading");
  });

  it("lets a tab the person chose to leave with unsaved text go at once", async () => {
    await open("/settings/account");
    const label = container.querySelectorAll("label").find(element => element.textContent === "Display name")!;
    const input = container.querySelector(`[id="${label.getAttribute("for")}"]`)!;
    const props = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[props].onChange({ target: { value: "Ada Lovelace" } }));
    closeGate();
    // The person was asked and let the text go; the address moves on.
    await change("/settings/tokens");
    expect(byId("account")).toBeNull();
    expect(shown()).toEqual([]);
    await openGate();
    expect(shown().map(tabOf)).toEqual(["tokens"]);
  });

  it("says the page is loading only after 300 ms while the account is read", async () => {
    closeGate();
    gateAccount = true;
    await open("/settings/account");
    expect(container.querySelector("h1")?.textContent).toBe("Settings");
    expect(container.textContent).not.toContain("Loading");
    await pause(320);
    expect(container.textContent).toContain("Loading settings…");
    await openGate();
    expect(byId("account")).not.toBeNull();
    expect(container.textContent).not.toContain("Loading");
  });
});

describe("leaving a tab with unsaved text", () => {
  const dialog = () => host.document.querySelector('[role="dialog"]');
  const answer = (label: string) => act(async () => {
    dialog()!.querySelectorAll("button").find(button => button.textContent === label)!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  const link = (label: string) => column().querySelectorAll("a").find(a => a.textContent === label)!;
  async function type(label: string, text: string) {
    const tag = container.querySelectorAll("label").find(element => element.textContent === label)!;
    const input = (tag.getAttribute("for") ? container.querySelector(`[id="${tag.getAttribute("for")}"]`) : tag.querySelector("input"))!;
    const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { value: text } }));
  }
  const click = (target: HostElement) => act(async () => {
    const event = new HostEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  });
  /** Back by one entry: the entry under the page's extra one has the router's state, and the same address. */
  async function back() {
    browser.state = null;
    await act(async () => { host.window.dispatchEvent({ type: "popstate" } as unknown as Event); });
    await settle();
  }

  it("asks before the column leaves a tab with unsaved typed text, naming the card, and leaves only when told", async () => {
    await open("/settings/account");
    await type("Display name", "Ada Lovelace");
    const held = await click(link("API & MCP"));
    expect(held.defaultPrevented).toBe(true);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Discard unsaved changes?");
    expect(dialog()?.textContent).toContain("Account has changes that are not saved.");
    await answer("Keep editing");
    expect(dialog()).toBeNull();
    expect(nav.push).not.toHaveBeenCalled();
    expect(byId("account")).not.toBeNull();
    await click(link("API & MCP"));
    await answer("Discard changes");
    // The extra entry the unsaved text added goes first, then the link.
    expect(browser.steps).toEqual([-1]);
    expect(nav.push).not.toHaveBeenCalled();
    await back();
    expect(nav.push).toHaveBeenCalledWith("/settings/tokens", { scroll: false });
  });

  it("asks while a new token's secret is on screen, in its own words", async () => {
    await open("/settings/tokens");
    await type("Token name", "CLI");
    await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(container.textContent).toContain("Copy this token now.");
    expect((await click(link("Account"))).defaultPrevented).toBe(true);
    expect(dialog()?.textContent).toContain("The new token will not be shown again.");
  });

  it("asks while a token's name is typed or its creation is on the way, naming the card, then in the secret's own words", async () => {
    await open("/settings/tokens");
    await type("Token name", "CLI");
    expect((await click(link("Account"))).defaultPrevented).toBe(true);
    expect(dialog()?.textContent).toContain("API / MCP tokens has changes that are not saved.");
    await answer("Keep editing");
    holdCreation = true;
    await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(answerCreation).not.toBeNull();
    expect(container.textContent).not.toContain("Copy this token now.");
    expect((await click(link("Account"))).defaultPrevented).toBe(true);
    expect(dialog()?.textContent).toContain("API / MCP tokens has changes that are not saved.");
    await answer("Keep editing");
    await act(async () => { answerCreation!(); });
    await settle();
    expect(container.textContent).toContain("Copy this token now.");
    expect((await click(link("Account"))).defaultPrevented).toBe(true);
    expect(dialog()?.textContent).toContain("The new token will not be shown again.");
    expect(dialog()?.textContent).not.toContain("has changes that are not saved");
    await answer("Keep editing");
    // Done: nothing holds the page any more, so the extra entry goes and nothing asks.
    await act(async () => { container.querySelectorAll("button").find(button => button.textContent === "Done")!.click(); });
    expect(browser.steps).toEqual([-1]);
    await click(link("Account"));
    expect(dialog()).toBeNull();
  });

  it("never asks when nothing typed is unsaved", async () => {
    await open("/settings/account");
    expect((await click(link("API & MCP"))).defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("holds back: unsaved text adds one entry at the same address, so Back stays on the tab, in the document, and asks", async () => {
    await open("/settings/account");
    expect(browser.pushed).toEqual([]);
    await type("Display name", "Ada Lovelace");
    expect(browser.pushed).toHaveLength(1);
    await type("Display name", "Ada Lovelace King");
    expect(browser.pushed).toHaveLength(1);
    await back();
    expect(traversalKept()).toBe(true);
    expect(dialog()?.textContent).toContain("Account has changes that are not saved.");
    expect(byId("account")).not.toBeNull();
    await answer("Keep editing");
    expect(browser.pushed).toHaveLength(2);
    expect(nav.push).not.toHaveBeenCalled();
    // Back again, letting the tab go: back once more, and the workspace's reload is not kept.
    await back();
    await answer("Discard changes");
    expect(browser.steps).toEqual([-1]);
    expect(traversalKept()).toBe(false);
  });

  it("takes a jump past the tab while it holds, asks, and hands the step to the workspace on Discard", async () => {
    const ended = vi.fn();
    const withdraw = endTraversalsWith(ended);
    try {
      await open("/settings/account");
      await type("Display name", "Ada Lovelace");
      // The browser jumped from its history list to a map; the router has not heard it.
      shownAt = "/maps";
      expect(traversalTaken()).toBe(true);
      const step = { type: "popstate", stopImmediatePropagation: vi.fn() };
      await act(async () => { host.window.dispatchEvent(step as unknown as Event); });
      await settle();
      expect(step.stopImmediatePropagation).toHaveBeenCalled();
      expect(dialog()?.textContent).toContain("Account has changes that are not saved.");
      expect(byId("account")).not.toBeNull();
      await answer("Discard changes");
      expect(ended).toHaveBeenCalledOnce();
      expect(nav.push).not.toHaveBeenCalled();
    } finally { withdraw(); }
  });

  it("takes the extra entry away unseen once the text is put back", async () => {
    await open("/settings/account");
    await type("Display name", "Ada Lovelace");
    expect(browser.pushed).toHaveLength(1);
    await type("Display name", "Ada Okafor");
    expect(browser.steps).toEqual([-1]);
    expect(dialog()).toBeNull();
  });

  it("asks the browser's own question on reload or closing while typed text is unsaved", async () => {
    await open("/settings/account");
    const quiet = { type: "beforeunload", preventDefault: vi.fn(), returnValue: undefined as unknown };
    host.window.dispatchEvent(quiet);
    expect(quiet.preventDefault).not.toHaveBeenCalled();
    await type("Display name", "Ada Lovelace");
    const held = { type: "beforeunload", preventDefault: vi.fn(), returnValue: undefined as unknown };
    host.window.dispatchEvent(held);
    expect(held.preventDefault).toHaveBeenCalled();
    expect(held.returnValue).toBe("");
  });
});

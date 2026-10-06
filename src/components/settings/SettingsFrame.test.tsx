import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostElement, installDomHost } from "../testing/dom-host";
import { openPrivateState } from "../auth/private-state";
import { DISPLAY_NAME_EVENT } from "../UserBadge";
import { INSTANCE_NAME_EVENT } from "../shell/path-model";
import { readLastTab, writeLastTab } from "./last-tab";
import { SettingsFrame } from "./SettingsFrame";

/**
 * The frame over the shipped cards: who sees which tab, where each
 * address lands, the shipped fragment links, and the tab this browser
 * session reopens. The reads are faked; nothing here reaches a server.
 */

const nav = vi.hoisted(() => ({ pathname: "/settings", hash: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), prefetch: vi.fn() }),
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

let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;
let admin = true;
let accountName = "Ada Okafor";

beforeEach(() => {
  requests.length = 0; scrolled.length = 0; accountName = "Ada Okafor";
  nav.pathname = "/settings"; nav.hash = ""; nav.replace = vi.fn((address: string) => {
    const at = address.indexOf("#");
    nav.pathname = at < 0 ? address : address.slice(0, at);
    nav.hash = at < 0 ? "" : address.slice(at);
  });
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    if (url === "/api/account") {
      return Response.json({ account: { id: "ada", name: accountName, email: "ada@example.test", sqlName: "ada", isAdmin: admin } });
    }
    if (url === "/api/settings") return Response.json({ instanceName: "Atlas" });
    if (url === "/api/account/tokens") return Response.json({ tokens: [] });
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  }));
  openPrivateState("ada");
  host = installDomHost();
  Object.assign(host.window, { location: { get hash() { return nav.hash; }, get pathname() { return nav.pathname; } } });
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

describe("the Settings frame", () => {
  it("draws the heading and, for an admin, You and Instance whole with Users at the foot", async () => {
    await open("/settings/account");
    expect(container.querySelector("h1")?.textContent).toBe("Settings");
    expect(column().getAttribute("aria-label")).toBe("Settings");
    expect(columnLinks()).toEqual([
      { text: "Account", href: "/settings/account" },
      { text: "Tokens", href: "/settings/tokens" },
      { text: "General", href: "/settings/general" },
      { text: "Limits", href: "/settings/limits" },
      { text: "System", href: "/settings/system" },
      { text: "Users", href: "/users" },
    ]);
    expect(column().textContent).toContain("You");
    expect(column().textContent).toContain("Instance");
  });

  it("shows a member Account, Tokens and General only, and never makes the configuration read", async () => {
    await open("/settings/general", "", "member");
    expect(columnLinks().map(link => link.text)).toEqual(["Account", "Tokens", "General"]);
    expect(requests).not.toContain("/api/instance/settings");
    expect(requests.every(url => !url.startsWith("/api/instance"))).toBe(true);
  });

  it("marks the tab on screen in the column", async () => {
    await open("/settings/tokens");
    const current = column().querySelectorAll('a[aria-current="page"]');
    expect(current.map(a => a.textContent)).toEqual(["Tokens"]);
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

  it("lands the shipped tokens link on the Tokens heading", async () => {
    await open("/settings", "#tokens-heading");
    expect(nav.replace).toHaveBeenCalledWith("/settings/tokens#tokens-heading", { scroll: false });
    const card = byId("tokens-heading")!.closest("section")!;
    expect(card.hasAttribute("data-marked")).toBe(true);
    expect(scrolled).toEqual([""]);
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
    await act(async () => { host.window.dispatchEvent(new CustomEvent(INSTANCE_NAME_EVENT, { detail: "Atlas North" })); });
    await settle();
    nav.pathname = "/settings/tokens"; await follow();
    nav.pathname = "/settings/account"; await follow();
    // The account card's first field is the display name.
    expect(container.querySelectorAll("input")[0]?.value).toBe("Ada Lovelace");
    nav.pathname = "/settings/general"; await follow();
    expect(container.querySelector("input")?.value).toBe("Atlas North");
  });

  it("takes only the router's next answer for the address it asked for", async () => {
    await open("/settings/limits", "#not a row");
    expect(nav.replace).toHaveBeenCalledWith("/settings/limits", { scroll: false });
    nav.pathname = "/settings/tokens"; await follow();
    nav.pathname = "/settings/limits"; await follow();
    expect(column().querySelectorAll('a[aria-current="page"]').map(a => a.textContent)).toEqual(["Limits"]);
  });
});

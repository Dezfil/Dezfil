import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { EntryScreen } from "./EntryScreen";

/**
 * The entry screen with what an admin set for it: the sign-in page's
 * message drawn as text, the lost-password line from the contact, and
 * the page a person lands on after signing in, creating the first account
 * or redeeming an invitation. The entry read and the entry forms are
 * fakes; the browser's address is a recorded replace.
 */

vi.mock("@/components/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ThemeToggle: () => null,
}));

interface Entry { instanceName: string | null; signInMessage: string; lostPasswordContact: string; landingPage: string; passwordMin?: number; setupRequired: boolean }
let entry: Entry;
let posted: { url: string; body: unknown }[];
let replaced: string[];
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; },
  };
}

beforeEach(() => {
  entry = { instanceName: "Atlas", signInMessage: "", lostPasswordContact: "", landingPage: "home", passwordMin: 8, setupRequired: false };
  posted = []; replaced = [];
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/auth/entry") return Response.json(entry);
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ account: { id: "ada" } });
  }));
  host = installDomHost();
  Object.assign(host.window, { location: { origin: "https://dezfil.example", hash: "#secret=once", replace: (href: string) => { replaced.push(href); } } });
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
async function open(mode: "setup" | "sign-in" | "redeem") {
  await act(async () => root.render(<EntryScreen mode={mode} />));
  await settle();
}
async function type(label: string, text: string) {
  const tag = container.querySelectorAll("label").find(element => element.textContent === label)!;
  const input = (tag.getAttribute("for") ? container.querySelector(`[id="${tag.getAttribute("for")}"]`) : tag.querySelector("input"))!;
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
  await act(async () => (input as unknown as Record<string, { onChange: (e: unknown) => void }>)[key].onChange({ target: { value: text } }));
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();
}
const heading = () => container.querySelector("h1")!.parentElement!;
const lines = () => container.querySelectorAll("p").map(p => p.textContent);

describe("the sign-in page", () => {
  it("shows a stored message under its heading as literal text, markup and all", async () => {
    entry.signInMessage = "<img src=x onerror=alert(1)> Use your <b>work</b> email.\nNew here? Ask the GIS team.";
    await open("sign-in");
    expect(heading().querySelectorAll("p").map(p => p.textContent)).toEqual([entry.signInMessage]);
    expect(container.querySelectorAll("img")).toEqual([]);
    expect(container.querySelectorAll("b")).toEqual([]);
  });

  it("shows no message when none is stored", async () => {
    await open("sign-in");
    expect(heading().querySelectorAll("p")).toEqual([]);
  });

  it("names the contact in the forgot line, its trailing period dropped, or keeps the shipped line", async () => {
    await open("sign-in");
    expect(lines()).toContain("Forgot your password? An admin can reset it.");
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    entry.lostPasswordContact = "the GIS team at gis@example.org.";
    await open("sign-in");
    expect(lines()).toContain("Forgot your password? Ask the GIS team at gis@example.org.");
    expect(lines()).not.toContain("Forgot your password? An admin can reset it.");
  });

  it("lands on the stored landing page after signing in", async () => {
    entry.landingPage = "maps";
    await open("sign-in");
    await type("Email", "ada@example.test");
    await type("Password", "paper cranes at sunrise");
    await submit();
    expect(posted.map(post => post.url)).toEqual(["/api/auth/sign-in"]);
    expect(replaced).toEqual(["https://dezfil.example/maps"]);
  });

  it("lands Home for a landing value it does not know, never using the value as an address", async () => {
    entry.landingPage = "//elsewhere.example/steal";
    await open("sign-in");
    await type("Email", "ada@example.test");
    await type("Password", "paper cranes at sunrise");
    await submit();
    expect(replaced).toEqual(["https://dezfil.example/"]);
  });
});

describe("the shortest password", () => {
  it("is named on the invitation page as the entry read gives it", async () => {
    entry = { ...entry, passwordMin: 12 };
    await open("redeem");
    expect(lines()).toContain("At least 12 characters.");
    expect(container.textContent).not.toContain("At least 8 characters.");
  });

  it("is named on the first-account page as the entry read gives it, and never on the sign-in page", async () => {
    entry = { ...entry, setupRequired: true, passwordMin: 8 };
    await open("setup");
    expect(lines()).toContain("At least 8 characters.");
    act(() => root.unmount());
    root = createRoot(container as unknown as Element);
    entry = { ...entry, setupRequired: false, passwordMin: 12 };
    await open("sign-in");
    expect(container.textContent).not.toMatch(/At least \d+ characters/);
  });
});

describe("the first-account and invitation pages", () => {
  it("show no message and no forgot line, and land on the stored page once done", async () => {
    entry = { ...entry, setupRequired: true, signInMessage: "Use your work email.", lostPasswordContact: "the GIS team", landingPage: "projects" };
    await open("setup");
    expect(container.textContent).not.toContain("Use your work email.");
    expect(container.textContent).not.toContain("Forgot your password?");
    await type("Name", "Ada");
    await type("Email", "ada@example.test");
    await type("Password", "paper cranes at sunrise");
    await submit();
    expect(posted.map(post => post.url)).toEqual(["/api/auth/setup"]);
    expect(replaced).toEqual(["https://dezfil.example/projects"]);
  });

  it("land a redeemed invitation on the stored page, signed in or not", async () => {
    entry = { ...entry, signInMessage: "Use your work email.", landingPage: "sql" };
    await open("redeem");
    expect(container.textContent).not.toContain("Use your work email.");
    await type("Password", "paper cranes at sunrise");
    await submit();
    expect(posted).toEqual([{ url: "/api/auth/redeem", body: { secret: "once", password: "paper cranes at sunrise" } }]);
    expect(replaced).toEqual(["https://dezfil.example/sql"]);
  });
});

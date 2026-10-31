import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/metadata/accounts";
import { HostEvent, installDomHost, type HostElement } from "../testing/dom-host";
import { UsersScreen } from "./UsersScreen";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a>,
}));

/**
 * Users on an instance with a sign-in service: no row offers Reset password
 * or New sign-in link, the person's own row no Change password, and an
 * invitation hands over the way in with no link. With the mode off each is as
 * it always was. While the mode cannot be read the page says so, with its retry,
 * and draws no row. The reads are fakes.
 */

const base = { sqlName: "x", isAdmin: false, isOriginal: false, createdAt: "2026-01-01", updatedAt: "2026-01-01", lastSignInAt: null };
const ME: Account = { ...base, id: "me", name: "Me Self", email: "me@example.test", status: "active", isAdmin: true };
const ACTIVE: Account = { ...base, id: "ada", name: "Ada Okafor", email: "ada@example.test", status: "active" };
const INVITED: Account = { ...base, id: "bo", name: "Bo Quill", email: "bo@example.test", status: "invited" };
const NEW: Account = { ...base, id: "cy", name: "Cy Marsh", email: "cy@example.test", status: "invited" };

let config: () => Response;
let invitation: () => Response;
let host: ReturnType<typeof installDomHost>;
let root: ReturnType<typeof createRoot>;
let container: HostElement;

beforeEach(() => {
  config = () => Response.json({ externalSignIn: { enabled: true } });
  invitation = () => Response.json({ account: NEW }, { status: 201 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/config") return config();
    if (url === "/api/account") return Response.json({ account: ME });
    if (url === "/api/users" && init.method === "POST") return invitation();
    if (url === "/api/users") return Response.json({ users: [ME, ACTIVE, INVITED], deletions: [] });
    throw new Error(`Unexpected ${url}`);
  }));
  host = installDomHost();
  container = host.document.createElement("div");
  host.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  act(() => root.unmount());
  host.uninstall();
  vi.unstubAllGlobals();
});

const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function mount() { await act(async () => root.render(<UsersScreen />)); await settle(); }
const line = (name: string) => container.querySelectorAll("button[aria-expanded]").find(button => button.textContent?.includes(name))!;
async function expand(name: string) { await act(async () => { line(name).click(); }); }
const row = (name: string) => line(name).parentElement!;
const offered = (name: string) => row(name).querySelectorAll("button").filter(button => button !== line(name)).map(button => button.textContent);
const press = (label: string) => act(async () => { container.querySelectorAll("button").find(button => button.textContent === label)!.click(); });
const LINE = (email: string) => `They sign in at the sign-in service with ${email}. There is no link to send.`;

async function invite() {
  await act(async () => { container.querySelectorAll("button").find(button => button.textContent?.includes("Invite"))!.click(); });
  for (const [label, value] of [["Name", "Cy Marsh"], ["Email", "cy@example.test"]]) {
    const input = container.querySelectorAll("input").find(element => element.getAttribute("aria-label") === label)!;
    const key = Object.keys(input).find(name => name.startsWith("__reactProps$"))!;
    await act(async () => (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key].onChange({ target: { value } }));
  }
  await act(async () => { container.querySelector('form[aria-label="Invite user"]')!.dispatchEvent(new HostEvent("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

describe("in the mode", () => {
  it("offers an active person no Reset password, keeping the rest", async () => {
    await mount(); await expand("Ada Okafor");
    expect(offered("Ada Okafor")).toEqual(["Make admin", "Deactivate"]);
  });

  it("offers an invited person no New sign-in link, and says how they sign in", async () => {
    await mount(); await expand("Bo Quill");
    expect(offered("Bo Quill")).toEqual(["Make admin", "Deactivate", "Delete account"]);
    expect(row("Bo Quill").textContent).toContain(LINE("bo@example.test"));
  });

  it("says nothing of the kind on an active person's row", async () => {
    await mount(); await expand("Ada Okafor");
    expect(row("Ada Okafor").textContent).not.toContain("sign-in service");
  });

  it("offers no Change password on the person's own row", async () => {
    await mount(); await expand("Me Self");
    expect(row("Me Self").textContent).not.toContain("Change password");
  });

  it("hands over an invitation with no link, then shows the row's actions", async () => {
    await mount(); await invite();
    expect(row("Cy Marsh").textContent).toContain(LINE("cy@example.test"));
    expect(row("Cy Marsh").querySelectorAll("input")).toEqual([]);
    expect(row("Cy Marsh").textContent).not.toContain("Copy link");
    expect(offered("Cy Marsh")).toEqual(["Done"]);
    expect(container.textContent).toContain("Account created for Cy Marsh");
    await press("Done");
    expect(offered("Cy Marsh")).toEqual(["Make admin", "Deactivate", "Delete account"]);
    expect(row("Cy Marsh").textContent).toContain(LINE("cy@example.test"));
  });
});

describe("with the mode off", () => {
  beforeEach(() => {
    config = () => Response.json({ externalSignIn: { enabled: false } });
    invitation = () => Response.json({ account: NEW, signInUrl: "https://dezfil.example/accept#secret=once", expiresAt: "2026-11-07T00:00:00.000Z" }, { status: 201 });
  });

  it("offers Reset password, New sign-in link and Change password as always, with no line about a service", async () => {
    await mount(); await expand("Ada Okafor");
    expect(offered("Ada Okafor")).toEqual(["Reset password", "Make admin", "Deactivate"]);
    await expand("Bo Quill");
    expect(offered("Bo Quill")).toEqual(["New sign-in link", "Make admin", "Deactivate", "Delete account"]);
    expect(container.textContent).not.toContain("sign-in service");
    await expand("Me Self");
    expect(row("Me Self").textContent).toContain("Change password");
  });

  it("hands over the link", async () => {
    await mount(); await invite();
    expect(row("Cy Marsh").querySelector("input")).not.toBeNull();
    expect(row("Cy Marsh").textContent).toContain("Shown once. No email is sent; share this link privately.");
    expect(offered("Cy Marsh")).toEqual(["Copy link", "Done"]);
  });
});

describe("while the mode cannot be read", () => {
  const offersNothing = () => {
    expect(container.querySelectorAll("button[aria-expanded]")).toEqual([]);
    for (const words of ["Reset password", "New sign-in link", "Change password"]) expect(container.textContent).not.toContain(words);
  };

  it("says so in the server's words, with its retry, and draws no row to act on", async () => {
    config = () => Response.json({ error: { code: "internal", message: "The configuration could not be read." } }, { status: 500 });
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The configuration could not be read.");
    offersNothing();
  });

  it("says so when the server cannot be reached", async () => {
    config = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    offersNothing();
  });

  it("draws the rows the mode calls for once the retry reads it", async () => {
    config = () => Response.json({ error: { code: "internal", message: "No." } }, { status: 500 });
    await mount();
    config = () => Response.json({ externalSignIn: { enabled: true } });
    await press("Try again");
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await expand("Ada Okafor");
    expect(offered("Ada Okafor")).toEqual(["Make admin", "Deactivate"]);
  });
});
